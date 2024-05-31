import * as THREE from './Three/three.module.js';
import Stats from './Three/stats.module.js';  // 性能监视器
import { GUI } from './Three/lil-gui.module.min.js';  // 图形接口

let stats;
let camera, scene, renderer;
let boxmesh, groundMesh;
const dom = document.getElementById('container');

const viewer = new Cesium.Viewer(dom, {
	// terrain: Cesium.Terrain.fromWorldTerrain(),
	terrainProvider: await Cesium.createWorldTerrainAsync(),
	animation: false,
	baseLayerPicker: false,
	fullscreenButton: false,
	geocoder: false,
	homeButton: false,
	infoBox: false,
	sceneModePicker: false,
	selectionIndicator: false,
	timeline: false,
	navigationHelpButton: false,
	navigationInstructionsInitiallyVisible: false,
	skyAtmosphere: false,
	useDefaultRenderLoop: false,
}
);

viewer.scene.globe.depthTestAgainstTerrain = true;
const gl = viewer.scene.canvas.getContext('webgl2');

viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
viewer.scene.screenSpaceCameraController.tiltEventTypes = [Cesium.CameraEventType.PINCH, Cesium.CameraEventType.RIGHT_DRAG];
viewer._cesiumWidget._creditContainer.style.display = "none";

viewer.camera.setView({
	destination: Cesium.Cartesian3.fromDegrees(120.002, 30.278, 1000)// IT公园经纬度
});
// viewer.camera.flyTo({
//     destination: Cesium.Cartesian3.fromDegrees(120.002, 30.278, 1000),
//     orientation: {
//         heading: Cesium.Math.toRadians(0.0),
//         pitch: Cesium.Math.toRadians(-90.0),
//         roll: 0.0
//     },
//     duration: 5
// });

// 获取 Cesium 的颜色的 stage
const getColorStage = new Cesium.PostProcessStage({
	fragmentShader: `
		uniform sampler2D colorTexture;
		in vec2 v_textureCoordinates;
		void main(void){
			out_FragColor = texture(colorTexture, v_textureCoordinates);;
		}`
});

// 获取 Cesium 的原生深度的 stage
const getCzmDepthStage = new Cesium.PostProcessStage({
	fragmentShader: `
		uniform sampler2D depthTexture;
		in vec2 v_textureCoordinates;
		void main(void){
			out_FragColor = texture(depthTexture, v_textureCoordinates);
		}`
});

// Three 相机近远裁面
const near = 5.0;
const far = 10000;
const shadowRangeRadius = 1000;
viewer.camera.frustum.near = near;

// 获取将 Cesium 的深度转换为 Three 的深度的 stage
const getThreeDepthStage = new Cesium.PostProcessStage({
	fragmentShader: `
		uniform sampler2D depthTexture;
		uniform float three_near;
		uniform float three_far;

		in vec2 v_textureCoordinates;

		float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
			// -near maps to 0; -far maps to 1
			return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
		}

		float perspectiveDepthToViewZ( const in float line_depth, const in float near, const in float far ) {
			// maps perspective line_depth in [ 0, 1 ] to viewZ
			return ( near * far ) / ( ( far - near ) * line_depth - far );
		}
		

		void main(void){
			vec4 pach_depth = texture(depthTexture, v_textureCoordinates);// pack 后的对数深度
			float unpack_depth = czm_unpackDepth(pach_depth);// unpack 对数深度
			float linearDepth = czm_reverseLogDepth(unpack_depth);// 转换为线性深度
			float czm_view_z = perspectiveDepthToViewZ(linearDepth, czm_currentFrustum.x, czm_currentFrustum.y);// 计算 cesium 的 viewZ
			linearDepth = viewZToPerspectiveDepth(czm_view_z, three_near, three_far);// 根据 viewZ 计算 Three 的线性深度
			vec4 pack_depth = czm_packDepth(linearDepth);// pack 深度到 RGBA
			pack_depth.x = mix(pack_depth.x, 1.0, step(1.0, linearDepth));// 解决 pack 深度时将 1.0 pack 成 0.0 的问题
			out_FragColor = pack_depth;
		}`,
	uniforms: {
		three_near: function () { return near; },
		three_far: function () { return far; }
	}
});

const gettextureStageComposite = new Cesium.PostProcessStageComposite({
	stages: [getThreeDepthStage, getCzmDepthStage, getColorStage],
	inputPreviousStageTexture: false
});

viewer.scene.postProcessStages.add(gettextureStageComposite);
const textloader = new THREE.TextureLoader();
const threeTexture = textloader.load('./img/image.png');

const positionRenderTarget = new THREE.WebGLRenderTarget(viewer.canvas.width, viewer.canvas.height);
const colorRenderTarget = new THREE.WebGLRenderTarget(viewer.canvas.width, viewer.canvas.height);
const czmDepthRenderTarget = new THREE.WebGLRenderTarget(viewer.canvas.width, viewer.canvas.height);
const depthRenderTarget = new THREE.WebGLRenderTarget(viewer.canvas.width, viewer.canvas.height);
// colorRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;
// czmDepthRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;
// depthRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;

/* 阴影计算（在 Three 中计算）：
 * 1. 用得到的 cesium 地面在 Three 中的深度反算出平面顶点在裁剪空间中的坐标；
 * 2. 对裁剪空间左边做逆投影变换后反归一化得到视图空间坐标；
 * 3. 对视图空间坐标做逆视图变换得到世界空间坐标；
 * 4. 用计算得到的世界空间坐标替换原 Three 中的世界坐标后，在片元中获取阴影 mask 并应用。
*/

let czmPlaneGeo = new THREE.PlaneGeometry(2, 2, 20, 100);// webgl 裁剪空间的坐标系是[-1, 1]，长宽需要设为 2，分段数越多阴影越平滑
const czmPlaneMat = new THREE.ShaderMaterial({
	uniforms: {
		...THREE.UniformsLib["lights"],
		receiveShadow: { value: true },
		projectionMatrixInverse: { value: new THREE.Matrix4() },
		viewMatrixInverse: { value: new THREE.Matrix4() },
		colorTexture: { value: colorRenderTarget.texture },
		czmDepthTexture: { value: czmDepthRenderTarget.texture },
		depthTexture: { value: depthRenderTarget.texture },
		cameraHeight: { value: 1000 },
		depthScale: { value: 1 },
		near: { value: near },
		far: { value: far }
	},
	vertexShader: `
		#include <common>
		#include <bsdfs>
		#include <shadowmap_pars_vertex>

		uniform mat4 projectionMatrixInverse;
		uniform mat4 viewMatrixInverse;
		uniform sampler2D depthTexture;
		uniform float depthScale;
		
		varying vec2 vUv;

		float czm_unpackDepth(vec4 packedDepth)
		{
			// See Aras Pranckevičius' post Encoding Floats to RGBA
			// http://aras-p.info/blog/2009/07/30/encoding-floats-to-rgba-the-final/
			return dot(packedDepth, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
		}

		void main(void){
			vUv = uv;
			float depth = czm_unpackDepth(texture2D(depthTexture, vUv));// cesium 转换为 Three 的线性深度
			vec4 pos = vec4(position.x, position.y, 2.0 * depth - 1.0, 1.0);// 计算出当前顶点的裁剪空间坐标
			vec4 view_pos = projectionMatrixInverse * pos;// 转为视图空间坐标
			view_pos = view_pos / view_pos.w;// 反归一化视图空间坐标
			view_pos.xyz *= depthScale;// 缩放
			vec4 world_pos = viewMatrixInverse * view_pos;// 转为世界空间坐标

			#include <beginnormal_vertex>
			#include <defaultnormal_vertex>
			// transformedNormal = vec3(0.0, 0.0, 1.0);// 保持法向量垂直于平面

			#include <begin_vertex>
			#include <worldpos_vertex>
			worldPosition = world_pos;// 更改原 Three 中的世界坐标，用以计算阴影

			#include <shadowmap_vertex>

			gl_Position = vec4(position.x, position.y, 1.0, 1.0);// 将平面绘制在相机正前方并占满屏幕
		} `,
	fragmentShader: `
		#include <common>
		#include <packing>
		#include <bsdfs>
		#include <lights_pars_begin>
		#include <shadowmap_pars_fragment>
		#include <shadowmask_pars_fragment>

		uniform sampler2D colorTexture;
		uniform sampler2D czmDepthTexture;
		uniform sampler2D depthTexture;
		uniform float cameraHeight;
		uniform float depthScale;
		uniform float near;
		uniform float far;

		varying vec2 vUv;

		const float Hight_Low = 30000.0;
		const float Hight_High = 300000.0;

		float czm_unpackDepth(vec4 packedDepth)
		{
			return dot(packedDepth, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
		}

		void main(void){
			vec4 color = texture2D(colorTexture, vUv);// cesium 颜色
			float czm_depth = czm_unpackDepth(texture2D(czmDepthTexture, vUv));// cesium 原生对数深度
			float heightAlpha = 1.0 - smoothstep(Hight_Low, Hight_High, cameraHeight);// 高度混合因子，高度越高越透明（显示 cesium 星空）
			float alpha = 1.0 - step(1.0, czm_depth) * heightAlpha;// cesium 原始深度为 1 的地方设为透明
			float depth = czm_unpackDepth(texture2D(depthTexture, vUv));// cesium 转换为 Three 的线性深度
			float viewZ = perspectiveDepthToViewZ(depth, near, far);// 计算 cesium 地面的 viewZ
			viewZ *= depthScale;// 缩放
			depth = viewZToPerspectiveDepth(viewZ, near, far);// 根据 viewZ 计算 Three 的线性深度
			float shadow = max(getShadowMask(), 0.2);// 计算阴影系数，最小为 0.2
			shadow = mix(shadow, 1.0, step(1.0, depth));// 不显示 Three 视锥体外的阴影
			// color *= 0.3;
			color *= shadow;// 应用阴影
			gl_FragColor = vec4(color.rgb, alpha);
			gl_FragDepth = depth;
	} `,
	lights: true,
	transparent: true,
});
// czmPlaneMat.opacity = 0.0;
let czmPlane = new THREE.Mesh(czmPlaneGeo, czmPlaneMat);
czmPlane.position.set(0, 0, -near);// 需要保证在相机的视锥内，否则会被裁剪掉
// czmPlane.rotation.x = - Math.PI / 2;
// czmPlane.receiveShadow = false;
// czmPlane.castShadow = false;
// czmPlane.visible = false;

// Cesium 坐标系和 Three 坐标系的对齐
const Alignment = {
	longitude: 120.002,
	latitude: 30.278,
	height: 0,
	rotation: 0,
	scale: 1,
	positionFactor: 1,
	_rotationMatrix: new Cesium.Matrix3(),
	_rotationMatrixInverse: new Cesium.Matrix3(),
	enuToEcefMatrix: new Cesium.Matrix4(),// 东北天到笛卡尔的坐标系转换矩阵
	ecefToEnuMatrix: new Cesium.Matrix4(),// 笛卡尔到东北天的坐标系转换矩阵
	update: function (opts) {
		if (!opts) return;
		if (opts.longitude != undefined || opts.latitude != undefined || opts.height != undefined) {
			opts.longitude != undefined && (this.longitude = opts.longitude);
			opts.latitude != undefined && (this.latitude = opts.latitude);
			opts.height != undefined && (this.height = opts.height);
			const pos = Cesium.Cartesian3.fromDegrees(this.longitude, this.latitude, this.height);
			this.enuToEcefMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
			Cesium.Matrix4.inverse(this.enuToEcefMatrix, this.ecefToEnuMatrix);
		}
		if (opts.rotation != undefined) {
			this.rotation = opts.rotation;
			Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(this.rotation), this._rotationMatrix);
			Cesium.Matrix3.inverse(this._rotationMatrix, this._rotationMatrixInverse);
		}
		if (opts.scale != undefined) {
			this.scale = opts.scale
			this.positionFactor = 1 / Math.max(this.scale, 0.00001);
		}
	},
	getThreeCoord: function (cartesian) {
		let position = Cesium.Matrix4.multiplyByPoint(this.ecefToEnuMatrix, cartesian, new Cesium.Cartesian3());// 笛卡尔坐标转为东北天坐标
		position = Cesium.Cartesian3.multiplyByScalar(position, this.positionFactor, new Cesium.Cartesian3());// 缩放
		position = Cesium.Matrix3.multiplyByVector(this._rotationMatrix, position, new Cesium.Cartesian3());// 旋转
		return new THREE.Vector3(position.y, position.z, position.x);
	},
	getCzmEcefCoord: function (pos) {
		let position = new Cesium.Cartesian3(pos.z, pos.x, pos.y);
		position = Cesium.Matrix3.multiplyByVector(this._rotationMatrixInverse, position, new Cesium.Cartesian3());// 反向旋转
		position = Cesium.Cartesian3.multiplyByScalar(position, 1 / this.positionFactor, new Cesium.Cartesian3());// 反向缩放
		position = Cesium.Matrix4.multiplyByPoint(this.enuToEcefMatrix, position, new Cesium.Cartesian3());// 东北天坐标转为笛卡尔坐标
		return new THREE.Vector3(position.x, position.y, position.z);
	},
	marchCzmCamera: function (threeCamera, viewer) {
		const czmPosition = viewer.camera.positionWC;
		const czmUpPosition = Cesium.Cartesian3.add(czmPosition, viewer.camera.upWC, new Cesium.Cartesian3());
		const czmTarget = Cesium.Cartesian3.add(czmPosition, viewer.camera.directionWC, new Cesium.Cartesian3());

		const position = this.getThreeCoord(czmPosition);
		const up = this.getThreeCoord(czmUpPosition).sub(position).normalize();
		const target = this.getThreeCoord(czmTarget);

		threeCamera.position.copy(position);
		threeCamera.up.copy(up);
		threeCamera.lookAt(target);

		threeCamera.updateProjectionMatrix();
	},
	marchThreeCamera: function (threeCamera, czmCamera) {
		const threePosition = threeCamera.position;
		const threeUpPosition = threePosition.clone().add(new THREE.Vector3(0, 1, 0).applyQuaternion(threeCamera.quaternion));
		const threeTarget = threePosition.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(threeCamera.quaternion));

		const position = this.getCzmEcefCoord(threeCamera.position);
		const up = this.getCzmEcefCoord(threeUpPosition).sub(position).normalize();
		const direction = this.getCzmEcefCoord(threeTarget).sub(position).normalize();

		czmCamera.setView({
			destination: position,
			orientation: {
				up: up,
				direction: direction
			}
		});
	},
}
Alignment.update({ longitude: 120.002, latitude: 30.278, height: 0, rotation: 0, scale: 1 });

function getCameraHeight(viewer) {
	var ellipsoid = viewer.scene.globe.ellipsoid;
	var cartesian = viewer.camera.positionWC;
	var cartographic = ellipsoid.cartesianToCartographic(cartesian);
	var height = cartographic.height;
	return height;
}

const cameraOpts = {
	px: 0,
	py: 1000.0000000009313,
	pz: 0,
	rx: -1.570796326794897,
	ry: 4.6007335219312955e-7,
	rz: -1.5707963263292355,
}


init();
animate();

// function 

function init() {
	// 渲染器
	const container = document.getElementById('container');
	renderer = new THREE.WebGLRenderer({ context: gl, canvas: viewer.canvas, antialias: true });
	// renderer = new THREE.WebGLRenderer({ antialias: true });
	// container.appendChild(renderer.domElement);
	// renderer.autoClear = false;
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.toneMapping = THREE.ACESFilmicToneMapping;

	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;

	// 场景&相机
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0xa4ccf0);
	camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, near, far);
	// camera.position.set(0, 100, 0);
	camera.fov = viewer.camera.frustum.fovy * 180 / Math.PI;
	camera.add(czmPlane)
	scene.add(camera);

	// 光线
	const light = new THREE.DirectionalLight(0xffffff, 5);
	light.castShadow = true;
	// light.shadow.mapSize.width = 4096;
	// light.shadow.mapSize.height = 4096;
	light.shadow.camera.near = 0.5;
	light.shadow.camera.far = shadowRangeRadius;
	light.shadow.camera.left = -shadowRangeRadius;
	light.shadow.camera.right = shadowRangeRadius;
	light.shadow.camera.top = shadowRangeRadius;
	light.shadow.camera.bottom = -shadowRangeRadius;
	light.position.set(100, 100, 110);
	scene.add(light);

	// 环境光
	const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
	scene.add(ambientLight);

	// 聚光灯
	const spotLight = new THREE.SpotLight(0xffffff);
	spotLight.position.set(120, 160, -20);
	spotLight.target.position.set(0, 120, 0);
	spotLight.castShadow = true;
	spotLight.shadow.camera.near = 0.5;
	spotLight.shadow.camera.far = 5000;
	spotLight.shadow.camera.fov = 30;
	spotLight.decay = 0;
	scene.add(spotLight);

	// 地面
	const groundGeometry = new THREE.PlaneGeometry(110, 110, 10, 10);
	const groundMaterial = new THREE.MeshStandardMaterial({
		color: 0x777777,
		side: THREE.DoubleSide,
		roughness: 0.8,
	});
	groundMaterial.map = threeTexture;
	groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
	groundMesh.castShadow = true;
	groundMesh.receiveShadow = true;
	groundMesh.rotation.x = - Math.PI / 2;
	groundMesh.position.set(0, 100, 0);
	scene.add(groundMesh);

	// 立方体
	const boxgeometry = new THREE.BoxGeometry(11, 1111, 11);
	const boxmaterial = new THREE.MeshStandardMaterial({ roughness: 0 });
	boxmesh = new THREE.Mesh(boxgeometry, boxmaterial);
	boxmesh.castShadow = true;
	boxmesh.receiveShadow = true;
	boxmesh.position.set(20, 10, 0);
	scene.add(boxmesh);

	const boxgeometry2 = new THREE.BoxGeometry(11, 11, 11);
	const boxmaterial2 = new THREE.MeshStandardMaterial({ roughness: 0 });
	const boxmesh2 = new THREE.Mesh(boxgeometry2, boxmaterial2);
	boxmesh2.castShadow = true;
	boxmesh2.receiveShadow = true;
	boxmesh2.position.set(10, 10, 10);
	scene.add(boxmesh2);

	const boxgeometry3 = new THREE.BoxGeometry(11, 11, 11);
	const boxmaterial3 = new THREE.MeshStandardMaterial({ roughness: 0 });
	const boxmesh3 = new THREE.Mesh(boxgeometry3, boxmaterial3);
	boxmesh3.castShadow = true;
	boxmesh3.receiveShadow = true;
	boxmesh3.position.set(10, 130, 10);
	scene.add(boxmesh3);

	// 性能监视器
	stats = new Stats();
	container.appendChild(stats.dom);

	function updateCamera() {
		camera.position.set(cameraOpts.px, cameraOpts.py, cameraOpts.pz);
		camera.rotation.set(cameraOpts.rx, cameraOpts.ry, cameraOpts.rz);
		Alignment.marchThreeCamera(camera, viewer.camera);
	}

	// GUI
	const gui = new GUI({ title: '控件' });
	const cameraFolder = gui.addFolder('three相机对齐');
	cameraFolder.add(Alignment, 'longitude', -180, 180).step(0.001).name('经度').onChange(() => Alignment.update({ longitude: Alignment.longitude }));
	cameraFolder.add(Alignment, 'latitude', -90, 90).step(0.001).name('纬度').onChange(() => Alignment.update({ latitude: Alignment.latitude }));
	cameraFolder.add(Alignment, 'height', -1000, 1000).step(10).name('高度').onChange(() => Alignment.update({ height: Alignment.height }));
	cameraFolder.add(Alignment, 'rotation', -180, 180).step(5).name('旋转').onChange(() => Alignment.update({ rotation: Alignment.rotation }));
	cameraFolder.add(Alignment, 'scale', 0.1, 10).step(0.1).name('缩放').onChange(() => Alignment.update({ scale: Alignment.scale }));
	const cameraFolder2 = gui.addFolder('cesium相机对齐');
	cameraFolder2.add(cameraOpts, 'px', -100, 100).step(1).name('位置x').onChange(updateCamera);
	cameraFolder2.add(cameraOpts, 'py', -2000, 2000).step(100).name('位置y').onChange(updateCamera);
	cameraFolder2.add(cameraOpts, 'pz', -100, 100).step(1).name('位置z').onChange(updateCamera);
	cameraFolder2.add(cameraOpts, 'rx', -Math.PI, Math.PI).step(0.1).name('旋转x').onChange(updateCamera);
	cameraFolder2.add(cameraOpts, 'ry', -Math.PI, Math.PI).step(0.1).name('旋转y').onChange(updateCamera);
	cameraFolder2.add(cameraOpts, 'rz', -Math.PI, Math.PI).step(0.1).name('旋转z').onChange(updateCamera);
	const boxFolder = gui.addFolder('立方体位置变换');
	boxFolder.add(boxmesh3.position, 'x', -100, 100).step(1).name('x');
	boxFolder.add(boxmesh3.position, 'y', -100, 100).step(1).name('y');
	boxFolder.add(boxmesh3.position, 'z', -100, 100).step(1).name('z');
	const boxFolder2 = gui.addFolder('立方体旋转变换');
	boxFolder2.add(boxmesh3.rotation, 'x', -Math.PI, Math.PI).step(0.1).name('x');
	boxFolder2.add(boxmesh3.rotation, 'y', -Math.PI, Math.PI).step(0.1).name('y');
	boxFolder2.add(boxmesh3.rotation, 'z', -Math.PI, Math.PI).step(0.1).name('z');
	const boxFolder3 = gui.addFolder('立方体缩放变换');
	boxFolder3.add(boxmesh3.scale, 'x', 0.1, 10).step(0.1).name('x');
	boxFolder3.add(boxmesh3.scale, 'y', 0.1, 10).step(0.1).name('y');
	boxFolder3.add(boxmesh3.scale, 'z', 0.1, 10).step(0.1).name('z');

	// 事件监听
	window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
	viewer.resize();
	renderer.setSize(window.innerWidth, window.innerHeight);
	camera.aspect = window.innerWidth / window.innerHeight;
	const fovx = viewer.camera.frustum.fov;
	const fovy = 2 * Math.atan(Math.tan(fovx / 2) / camera.aspect);
	// const fovx = 2 * Math.atan(Math.tan(fovy / 2) * camera.aspect);
	camera.fov = fovy * 180 / Math.PI;
	camera.updateProjectionMatrix();

	positionRenderTarget.setSize(viewer.canvas.width, viewer.canvas.height);
	colorRenderTarget.setSize(viewer.canvas.width, viewer.canvas.height);
	czmDepthRenderTarget.setSize(viewer.canvas.width, viewer.canvas.height);
	depthRenderTarget.setSize(viewer.canvas.width, viewer.canvas.height);
}

function animate() {
	requestAnimationFrame(animate);

	render();
	stats.update();
}

function render() {
	viewer.scene.initializeFrame();
	viewer.render();
	viewer.scene.render();

	// 将 Cesium 的颜色和深度贴图传递给 Three
	// Cesium 颜色贴图
	const czmColorTexture = getColorStage.outputTexture;
	renderer.properties.get(colorRenderTarget.texture).__webglTexture = czmColorTexture._texture;
	colorRenderTarget.texture.needsUpdate = true;

	// Cesium 的深度贴图
	const czmDepthTexture = getCzmDepthStage.outputTexture;
	renderer.properties.get(czmDepthRenderTarget.texture).__webglTexture = czmDepthTexture._texture;
	czmDepthRenderTarget.texture.needsUpdate = true;

	// 已经转换为 Three 的深度贴图
	const czm2ThreeDepthTexture = getThreeDepthStage.outputTexture;
	renderer.properties.get(depthRenderTarget.texture).__webglTexture = czm2ThreeDepthTexture._texture;
	depthRenderTarget.texture.needsUpdate = true;

	// 由于 Cesium 渲染时会改变 WebGl 的顶点数组缓冲区的绑定状态，因此 Three 渲染时需要重新绑定，Three 源码更改位置：
	// WebGLBindingStates/setup函数中将 if (updateBuffers || forceUpdate) 中的 if (index !== null) 移动到 if (updateBuffers || forceUpdate) 外部
	// 以保证每次渲染时都会重新绑定顶点数组缓冲区。

	Alignment.marchCzmCamera(camera, viewer);// 将 cesium 相机位置同步到Three相机
	cameraOpts.px = camera.position.x;
	cameraOpts.py = camera.position.y;
	cameraOpts.pz = camera.position.z;
	cameraOpts.rx = camera.rotation.x;
	cameraOpts.ry = camera.rotation.y;

	// 更新 uniform 变量
	czmPlaneMat.uniforms.projectionMatrixInverse.value = camera.projectionMatrixInverse
	czmPlaneMat.uniforms.viewMatrixInverse.value = camera.matrixWorld;
	czmPlaneMat.uniforms.cameraHeight.value = getCameraHeight(viewer);
	czmPlaneMat.uniforms.depthScale.value = Alignment.positionFactor;

	renderer.resetState();
	renderer.render(scene, camera);
}
// }
