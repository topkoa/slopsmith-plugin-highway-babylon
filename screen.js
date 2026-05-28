(function () {
    'use strict';

    const PLUGIN_ID = 'highway_babylon';
    const BABYLON_CDN = 'https://cdn.babylonjs.com/babylon.js';
    const EARCUT_CDN = 'https://cdn.jsdelivr.net/npm/earcut@2/dist/earcut.min.js';
    const FONT_URL = 'https://assets.babylonjs.com/fonts/Droid Sans_Regular.json';

    let _babylonPromise = null;
    function loadBabylon() {
        if (window.BABYLON) return Promise.resolve(window.BABYLON);
        if (_babylonPromise) return _babylonPromise;
        _babylonPromise = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = BABYLON_CDN;
            s.async = true;
            s.onload = () => res(window.BABYLON);
            s.onerror = () => rej(new Error('Babylon CDN load failed: ' + BABYLON_CDN));
            document.head.appendChild(s);
        });
        return _babylonPromise;
    }

    let _fontPromise = null;
    function loadFont() {
        if (_fontPromise) return _fontPromise;
        _fontPromise = fetch(FONT_URL).then(r => r.json()).catch(e => {
            console.warn('[' + PLUGIN_ID + '] font load failed:', e);
            return null;
        });
        return _fontPromise;
    }

    let _earcutPromise = null;
    function loadEarcut() {
        if (window.earcut) return Promise.resolve(window.earcut);
        if (_earcutPromise) return _earcutPromise;
        _earcutPromise = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = EARCUT_CDN;
            s.async = true;
            s.onload = () => res(window.earcut);
            s.onerror = () => rej(new Error('Earcut CDN load failed: ' + EARCUT_CDN));
            document.head.appendChild(s);
        });
        return _earcutPromise;
    }

    const SCALE = 2.25;
    const K = SCALE / 300;
    const NFRETS = 24;
    const TS = 200 * K;
    const AHEAD = 3.0;
    const BEHIND = 0.5;
    const MAX_PER_STRING = 96;
    const MAX_BEATS = 64;

    const MAX_STRINGS = 8;
    const DEFAULT_VIS_STR = 6;
    const OFFSCREEN_Y = -100;
    const STR_THICK = 0.25 * K;
    const LANE_OP_BASE = 0.12;
    const LANE_OP_INT = 0.24;
    const LANE_SPAN = 4;
    const MAX_CHORDS_VISIBLE = 48;
    const CHORD_FRAME_RIM_MIN_K = 0.055;
    const CHORD_FRAME_RIM_FRAC_H = 0.028;
    const CHORD_BOX_EDGE_ALPHA = 128 / 255;
    const CHORD_BOX_FILL_ALPHA = 32 / 255;
    const S_BASE = 3 * K;
    const S_GAP = 4 * K;
    const NOTE_W = 5 * K;
    const NOTE_H = 3 * K;
    const NOTE_D = 0.5 * K;
    const OPEN_SCALE_X = 40 * K / NOTE_W;
    const OPEN_SCALE_Y = 0.15;
    const OPEN_SCALE_Z = 0.6;
    const FRETTED_SCALE_Z = 2.5;
    const SUS_W = NOTE_W * 0.85;
    const SUS_H = NOTE_H * 0.12;

    const CAM_H_BASE = 150 * K;
    const CAM_DIST_BASE = 240 * K;
    const REF_ASPECT = 16 / 9;
    const FOCUS_D = 600 * K;
    const CAM_LERP_BASE = 0.05;
    const CAM_LOOKAHEAD_S = 1.4;
    const DESIRED_NDC_Y = -0.35;
    const TILT_BAND = 0.08;
    const TILT_STR = 0.6;

    const camBaseDistU = span => 65 + Math.max(span, 4) * 3;
    const camLowFretPullbackU = minFret => Math.max(0, 5 - minFret) * 4;
    const CAM_LOCK_CENTER_FRET = 6;
    const CAM_LOOKAHEAD_SEC = 3.0;
    const CAM_FOCUS_BLEND_RATE = 0.7;
    const CAM_FRET_EDGE_BLEND = 0.1;
    const DEFAULT_LOOKAHEAD_FRET_SPAN = 4;
    const CAM_DEFAULT_DIST = (camBaseDistU(12) + camLowFretPullbackU(1)) * K;

    const _hexToRgb = h => [((h >> 16) & 0xff) / 255, ((h >> 8) & 0xff) / 255, (h & 0xff) / 255];
    const S_COL = [
        _hexToRgb(0xff2828),
        _hexToRgb(0xffd400),
        _hexToRgb(0x2080ff),
        _hexToRgb(0xff8020),
        _hexToRgb(0x30d040),
        _hexToRgb(0xa040ff),
        _hexToRgb(0xff6bd5),
        _hexToRgb(0x6bffe6),
    ];

    const _fretXLog = f => {
        if (f <= 0) return 0;
        return SCALE - SCALE / Math.pow(2, f / 12);
    };
    const _fretXUniStep = _fretXLog(NFRETS) / NFRETS;
    const _fretXUni = f => f <= 0 ? 0 : f * _fretXUniStep;

    let _useUniformFrets = true;
    try { _useUniformFrets = localStorage.getItem('highway_babylon.fretSpacing') !== 'logarithmic'; } catch (_) {}

    function fretX(f) {
        return _useUniformFrets ? _fretXUni(f) : _fretXLog(f);
    }
    function fretMid(f) {
        if (f <= 0) return -2 * (SCALE / 300);
        return (fretX(f - 1) + fretX(f)) / 2;
    }

    function createInstance() {
        let B = null;
        let engine = null;
        let scene = null;
        let camera = null;
        let pipeline = null;
        let stringLineMeshes = [];
        let stringNoteMeshes = [];
        let stringMatrixBuffers = [];
        let isReady = false;
        let destroyed = false;
        let backendLabel = '';

        let curX = fretMid(CAM_LOCK_CENTER_FRET);
        let tgtX = curX;
        let curDist = CAM_DEFAULT_DIST;
        let tgtDist = CAM_DEFAULT_DIST;
        let curLookY = 0;
        let tgtLookY = 0;
        let aspectScale = 1;
        let nStr = 6;
        let inverted = false;

        let _lookaheadCamX = fretMid(CAM_LOCK_CENTER_FRET);
        let _lookaheadFretSpan = DEFAULT_LOOKAHEAD_FRET_SPAN;
        let _lookaheadLowBonusU = camLowFretPullbackU(1);

        let stringSusMeshes = [];
        let stringSusBuffers = [];
        let stringHitMeshes = [];
        let stringHitBuffers = [];
        let beatMeasureMesh = null;
        let beatMeasureBuffer = null;
        let beatQuarterMesh = null;
        let beatQuarterBuffer = null;
        let fretboardRoot = null;
        let lefty = false;
        let gizmoCam = null;
        let fretLabelPlanes = [];
        let fpsOverlay = null;
        let fpsLastUpdate = 0;
        let laneOddMesh = null;
        let laneOddMat = null;
        let laneOddBuffer = null;
        let laneEvenMesh = null;
        let laneEvenMat = null;
        let laneEvenBuffer = null;
        let laneDividerMesh = null;
        let laneDividerMat = null;
        let laneDividerBuffer = null;
        let chordFillMesh = null;
        let chordFillMat = null;
        let chordFillBuffer = null;
        let chordEdgeMesh = null;
        let chordEdgeMat = null;
        let chordEdgeBuffer = null;

        function sY(s) {
            const effS = inverted ? s : (nStr - 1 - s);
            return S_BASE + effS * S_GAP;
        }

        function writeMatrix(buf, idx, x, y, z, sx, sy, sz, cosA, sinA) {
            buf[idx + 0] = sx * cosA;
            buf[idx + 1] = sx * sinA;
            buf[idx + 2] = 0;
            buf[idx + 3] = 0;
            buf[idx + 4] = -sy * sinA;
            buf[idx + 5] = sy * cosA;
            buf[idx + 6] = 0;
            buf[idx + 7] = 0;
            buf[idx + 8] = 0;
            buf[idx + 9] = 0;
            buf[idx + 10] = sz;
            buf[idx + 11] = 0;
            buf[idx + 12] = x;
            buf[idx + 13] = y - OFFSCREEN_Y;
            buf[idx + 14] = z;
            buf[idx + 15] = 1;
        }

        function computeBPM(beats, currentTime) {
            if (!beats || beats.length < 4) return 120;
            let lastIdx = 0;
            for (let i = beats.length - 1; i >= 0; i--) {
                if (beats[i].time <= currentTime) { lastIdx = i; break; }
            }
            const start = Math.max(0, lastIdx - 4);
            const end = Math.min(beats.length - 1, lastIdx + 4);
            if (end <= start) return 120;
            const dt = beats[end].time - beats[start].time;
            if (dt <= 0) return 120;
            return (end - start) * 60 / dt;
        }

        function _lookaheadComputeFretBounds(now, notes, chords) {
            const tEnd = now + CAM_LOOKAHEAD_SEC;
            let minF = 99, maxF = 0, any = false;
            const consider = f => {
                if (!(f > 0)) return;
                if (f < minF) minF = f;
                if (f > maxF) maxF = f;
                any = true;
            };
            for (let i = 0; i < notes.length; i++) {
                const n = notes[i];
                if (n.t < now) continue;
                if (n.t > tEnd) break;
                consider(n.f | 0);
            }
            for (let i = 0; i < chords.length; i++) {
                const ch = chords[i];
                if (ch.t < now) continue;
                if (ch.t > tEnd) break;
                if (!ch.notes) continue;
                for (let j = 0; j < ch.notes.length; j++) consider(ch.notes[j].f | 0);
            }
            if (!any || minF > maxF) return null;
            return { minF, maxF };
        }

        function _lookaheadTargetWorldX(minF, maxF) {
            const middle = (fretMid(minF) + fretMid(maxF)) * 0.5;
            const weighted = 0.6 * fretX(0) + 0.4 * fretX(NFRETS);
            return middle * (1 - CAM_FRET_EDGE_BLEND) + weighted * CAM_FRET_EDGE_BLEND;
        }

        function _stableOpenX(noteT, notes, chords) {
            const tStart = noteT - 0.05;
            const tEnd = noteT + CAM_LOOKAHEAD_SEC;
            let minF = NFRETS, maxF = 0, any = false;
            for (let i = 0; i < notes.length; i++) {
                const n = notes[i];
                if (n.t < tStart) continue;
                if (n.t > tEnd) break;
                const f = n.f | 0;
                if (f > 0) {
                    if (f < minF) minF = f;
                    if (f > maxF) maxF = f;
                    any = true;
                }
            }
            for (let i = 0; i < chords.length; i++) {
                const ch = chords[i];
                if (ch.t < tStart) continue;
                if (ch.t > tEnd) break;
                if (!ch.notes) continue;
                for (let j = 0; j < ch.notes.length; j++) {
                    const f = ch.notes[j].f | 0;
                    if (f > 0) {
                        if (f < minF) minF = f;
                        if (f > maxF) maxF = f;
                        any = true;
                    }
                }
            }
            if (!any) return null;
            return _lookaheadTargetWorldX(minF, maxF);
        }

        function _lookaheadSmoothCamStep(dtSec, tgtXWorld, tgtSpanInt, tgtLowBonusU) {
            const d = Math.min(0.2, Math.max(1e-4, dtSec));
            const fs = 1 - Math.pow(1 - CAM_FOCUS_BLEND_RATE, d);
            _lookaheadCamX = tgtXWorld * fs + _lookaheadCamX * (1 - fs);
            _lookaheadFretSpan = tgtSpanInt * fs + _lookaheadFretSpan * (1 - fs);
            _lookaheadLowBonusU = tgtLowBonusU * fs + _lookaheadLowBonusU * (1 - fs);
        }

        function _camComputeTargets(bundle, dtSec) {
            const now = bundle.currentTime || 0;
            const notes = bundle.notes || [];
            const chords = bundle.chords || [];
            const bd = _lookaheadComputeFretBounds(now, notes, chords);

            if (!bd) {
                _lookaheadSmoothCamStep(dtSec, fretMid(CAM_LOCK_CENTER_FRET), 12, camLowFretPullbackU(1));
                tgtX = _lookaheadCamX;
                tgtDist = (camBaseDistU(12) + _lookaheadLowBonusU) * K;
                return;
            }
            const tgtWX = _lookaheadTargetWorldX(bd.minF, bd.maxF);
            const tgtSpanInt = Math.max(1, bd.maxF - bd.minF + 1);
            const tgtLowBonusU = camLowFretPullbackU(bd.minF);
            _lookaheadSmoothCamStep(dtSec, tgtWX, tgtSpanInt, tgtLowBonusU);
            tgtX = _lookaheadCamX;
            tgtDist = (camBaseDistU(_lookaheadFretSpan) + _lookaheadLowBonusU) * K;
        }

        function _camUpdate(bundle) {
            const bpm = computeBPM(bundle.beats, bundle.currentTime || 0);
            const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
            curX += (tgtX - curX) * lerp;
            curDist += (tgtDist - curDist) * lerp;
            const dist = curDist * aspectScale;
            const h = CAM_H_BASE * (dist / CAM_DIST_BASE);
            const mir = lefty ? -1 : 1;
            const shoulderOffset = mir * 20 * K;
            camera.position.set((curX * mir) + shoulderOffset, h * 0.95, dist * 0.75);

            const fretMidY = (sY(0) + sY(nStr - 1)) / 2;
            camera.setTarget(new B.Vector3(curX * mir, curLookY, -FOCUS_D * 0.35));
            scene.updateTransformMatrix();
            const ndcVp = new B.Viewport(0, 0, 1, 1);
            const probed = B.Vector3.Project(
                new B.Vector3(curX * mir, fretMidY, 0),
                B.Matrix.Identity(),
                scene.getTransformMatrix(),
                ndcVp
            );
            const probedNdcY = 1 - 2 * probed.y;
            if (probedNdcY < DESIRED_NDC_Y - TILT_BAND || probedNdcY > DESIRED_NDC_Y + TILT_BAND) {
                const correction = (DESIRED_NDC_Y - probedNdcY) * fretMidY * TILT_STR;
                tgtLookY = Math.max(-fretMidY, Math.min(fretMidY, tgtLookY - correction));
            }
            curLookY += (tgtLookY - curLookY) * lerp;
            camera.setTarget(new B.Vector3(curX * mir, curLookY, -FOCUS_D * 0.35));

            if (gizmoCam) {
                const target = camera.getTarget();
                const fwd = target.subtract(camera.position);
                const len = fwd.length();
                if (len > 1e-6) {
                    fwd.scaleInPlace(1 / len);
                    gizmoCam.position.copyFrom(fwd.scale(-1.8));
                    gizmoCam.setTarget(B.Vector3.Zero());
                }
            }
        }

        async function _init(canvas) {
            console.log('[' + PLUGIN_ID + '] _init: start, canvas=', canvas && canvas.id, canvas && canvas.width, 'x', canvas && canvas.height);
            B = await loadBabylon();
            console.log('[' + PLUGIN_ID + '] _init: babylon loaded, version=', B && B.Engine && B.Engine.Version);
            if (destroyed) { console.log('[' + PLUGIN_ID + '] _init: destroyed during load, aborting'); return; }

            console.log('[' + PLUGIN_ID + '] _init: forcing WebGL2 engine (POC)');
            try {
                engine = new B.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
                console.log('[' + PLUGIN_ID + '] _init: engine created');
            } catch (e) {
                console.error('[' + PLUGIN_ID + '] _init: engine create FAILED', e);
                return;
            }
            backendLabel = 'WebGL2';

            if (destroyed) { engine.dispose(); return; }

            scene = new B.Scene(engine);
            scene.useRightHandedSystem = true;
            scene.clearColor = new B.Color4(0.01, 0.012, 0.025, 1);
            scene.ambientColor = new B.Color3(0.15, 0.18, 0.25);
            fretboardRoot = new B.TransformNode('fretboardRoot', scene);
            console.log('[' + PLUGIN_ID + '] _init: scene created');

            const initialH = CAM_H_BASE * (CAM_DEFAULT_DIST / CAM_DIST_BASE);
            camera = new B.UniversalCamera('cam', new B.Vector3(curX + 20 * K, initialH * 0.95, CAM_DEFAULT_DIST * 0.75), scene);
            camera.setTarget(new B.Vector3(curX, 0, -FOCUS_D * 0.35));
            camera.fov = 70 * Math.PI / 180;
            camera.minZ = 0.01;
            camera.maxZ = 100;
            aspectScale = Math.max(1, REF_ASPECT / Math.max(engine.getAspectRatio(camera), 0.5));

            const GIZMO_LAYER = 0x10000000;
            const gizmoRoot = new B.TransformNode('gizmoRoot', scene);
            gizmoRoot.parent = fretboardRoot;
            gizmoRoot.position = new B.Vector3(0, 0.01, 0);
            const axLen = 0.5;
            const axThick = 0.03;
            const tipSize = 0.08;
            const makeAxis = (name, axisDir, col) => {
                const mat = new B.StandardMaterial('axMat_' + name, scene);
                mat.emissiveColor = new B.Color3(col[0], col[1], col[2]);
                mat.diffuseColor = new B.Color3(0, 0, 0);
                mat.specularColor = new B.Color3(0, 0, 0);
                mat.disableLighting = true;
                mat.backFaceCulling = false;
                const isX = axisDir === 'x';
                const isY = axisDir === 'y';
                const isZ = axisDir === 'z';
                const line = B.MeshBuilder.CreateBox('axLine_' + name, {
                    width: isX ? axLen : axThick,
                    height: isY ? axLen : axThick,
                    depth: isZ ? axLen : axThick,
                }, scene);
                line.position = new B.Vector3(isX ? axLen * 0.5 : 0, isY ? axLen * 0.5 : 0, isZ ? axLen * 0.5 : 0);
                line.material = mat;
                line.parent = gizmoRoot;
                line.layerMask = GIZMO_LAYER;
                const tip = B.MeshBuilder.CreateBox('axTip_' + name, { size: tipSize }, scene);
                tip.position = new B.Vector3(isX ? axLen : 0, isY ? axLen : 0, isZ ? axLen : 0);
                tip.material = mat;
                tip.parent = gizmoRoot;
                tip.layerMask = GIZMO_LAYER;
            };
            makeAxis('x', 'x', [1.0, 0.2, 0.2]);
            makeAxis('y', 'y', [0.2, 1.0, 0.2]);
            makeAxis('z', 'z', [0.3, 0.5, 1.0]);

            const makeLabel = (text, pos, col) => {
                const tex = new B.DynamicTexture('lblTex_' + text, { width: 128, height: 128 }, scene, false);
                tex.hasAlpha = true;
                const ctx = tex.getContext();
                ctx.clearRect(0, 0, 128, 128);
                tex.update();
                tex.drawText(text, null, null, 'bold 96px Arial', '#ffffff', null, true, true);
                const mat = new B.StandardMaterial('lblMat_' + text, scene);
                mat.diffuseTexture = tex;
                mat.opacityTexture = tex;
                mat.emissiveColor = new B.Color3(col[0], col[1], col[2]);
                mat.diffuseColor = new B.Color3(0, 0, 0);
                mat.specularColor = new B.Color3(0, 0, 0);
                mat.disableLighting = true;
                mat.backFaceCulling = false;
                mat.useAlphaFromDiffuseTexture = true;
                const plane = B.MeshBuilder.CreatePlane('lblPlane_' + text, { size: 0.22 }, scene);
                plane.material = mat;
                plane.position = new B.Vector3(pos[0], pos[1], pos[2]);
                plane.parent = gizmoRoot;
                plane.layerMask = GIZMO_LAYER;
                plane.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
            };
            const labelOffset = axLen + 0.18;
            makeLabel('X', [labelOffset, 0, 0], [1.0, 0.35, 0.35]);
            makeLabel('Y', [0, labelOffset, 0], [0.35, 1.0, 0.35]);
            makeLabel('Z', [0, 0, labelOffset], [0.45, 0.65, 1.0]);

            camera.layerMask = 0x0FFFFFFF;

            gizmoCam = new B.UniversalCamera('gizmoCam', new B.Vector3(0, 0, 2), scene);
            gizmoCam.setTarget(B.Vector3.Zero());
            gizmoCam.fov = 0.6;
            gizmoCam.minZ = 0.01;
            gizmoCam.maxZ = 100;
            gizmoCam.layerMask = GIZMO_LAYER;
            gizmoCam.viewport = new B.Viewport(0.005, 0.82, 0.12, 0.18);
            scene.activeCameras = [camera, gizmoCam];

            try {
                const parent = canvas.parentElement || document.body;
                fpsOverlay = document.createElement('div');
                fpsOverlay.id = 'highway_babylon_fps';
                fpsOverlay.style.cssText = [
                    'position:absolute',
                    'top:14px',
                    'left:170px',
                    'padding:4px 8px',
                    'background:rgba(0,0,0,0.45)',
                    'color:#9af',
                    'font-family:monospace',
                    'font-size:13px',
                    'font-weight:bold',
                    'pointer-events:none',
                    'z-index:1000',
                    'border-radius:4px',
                    'text-shadow:0 0 4px rgba(80,160,255,0.8)',
                ].join(';');
                fpsOverlay.textContent = '-- FPS';
                if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
                parent.appendChild(fpsOverlay);
            } catch (e) {
                console.warn('[' + PLUGIN_ID + '] FPS overlay setup failed:', e);
                fpsOverlay = null;
            }

            new B.HemisphericLight('h', new B.Vector3(0, 1, 0.3), scene).intensity = 0.45;
            const dir = new B.DirectionalLight('d', new B.Vector3(-0.3, -1, -0.4), scene);
            dir.intensity = 0.6;

            const shadowLight = new B.DirectionalLight('shadowLight', new B.Vector3(0, -1, 0.15), scene);
            shadowLight.position = new B.Vector3(SCALE * 0.5, 6, -1);
            shadowLight.intensity = 0.9;
            const shadowGen = new B.ShadowGenerator(1024, shadowLight);
            shadowGen.useBlurExponentialShadowMap = true;
            shadowGen.blurKernel = 24;
            shadowGen.darkness = 0.35;
            shadowGen.bias = 0.0005;

            const boardMat = new B.StandardMaterial('boardMat', scene);
            boardMat.diffuseColor = new B.Color3(0.20, 0.24, 0.32);
            boardMat.specularColor = new B.Color3(0, 0, 0);
            boardMat.emissiveColor = new B.Color3(0.003, 0.005, 0.008);
            boardMat.backFaceCulling = false;
            const boardDepth = (AHEAD + BEHIND) * TS + 1;
            const board = B.MeshBuilder.CreateGround('board', { width: SCALE, height: boardDepth }, scene);
            board.position = new B.Vector3(SCALE / 2, 0, (BEHIND - AHEAD) * 0.5 * TS);
            board.material = boardMat;
            board.parent = fretboardRoot;
            board.receiveShadows = true;

            const oddCol = _hexToRgb(0x3d739e);
            const evenCol = _hexToRgb(0x62a5d8);
            const makeLaneMesh = (name, col) => {
                const mat = new B.StandardMaterial(name + 'Mat', scene);
                mat.emissiveColor = new B.Color3(col[0], col[1], col[2]);
                mat.diffuseColor = new B.Color3(0, 0, 0);
                mat.specularColor = new B.Color3(0, 0, 0);
                mat.alpha = LANE_OP_BASE;
                mat.backFaceCulling = false;
                mat.disableDepthWrite = true;
                const mesh = B.MeshBuilder.CreateGround(name, { width: 1, height: 1 }, scene);
                mesh.material = mat;
                mesh.position.y = OFFSCREEN_Y;
                mesh.parent = fretboardRoot;
                const buf = new Float32Array(NFRETS * 16);
                mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
                mesh.thinInstanceCount = 0;
                mesh.renderingGroupId = 0;
                return { mesh, mat, buf };
            };
            const laneOdd = makeLaneMesh('laneOdd', oddCol);
            laneOddMesh = laneOdd.mesh; laneOddMat = laneOdd.mat; laneOddBuffer = laneOdd.buf;
            const laneEven = makeLaneMesh('laneEven', evenCol);
            laneEvenMesh = laneEven.mesh; laneEvenMat = laneEven.mat; laneEvenBuffer = laneEven.buf;

            laneDividerMat = new B.StandardMaterial('laneDivMat', scene);
            laneDividerMat.emissiveColor = new B.Color3(0.35, 0.70, 1.4);
            laneDividerMat.diffuseColor = new B.Color3(0, 0, 0);
            laneDividerMat.specularColor = new B.Color3(0, 0, 0);
            laneDividerMat.alpha = 0.08;
            laneDividerMat.backFaceCulling = false;
            laneDividerMat.disableDepthWrite = true;
            laneDividerMesh = B.MeshBuilder.CreateBox('laneDiv', { width: 0.45 * K, height: 0.45 * K, depth: 1 }, scene);
            laneDividerMesh.material = laneDividerMat;
            laneDividerMesh.position.y = OFFSCREEN_Y;
            laneDividerMesh.parent = fretboardRoot;
            laneDividerBuffer = new Float32Array((NFRETS + 2) * 16);
            laneDividerMesh.thinInstanceSetBuffer('matrix', laneDividerBuffer, 16, false);
            laneDividerMesh.thinInstanceCount = 0;
            laneDividerMesh.renderingGroupId = 0;

            const tealCol = _hexToRgb(0x00d2d5);
            chordFillMat = new B.StandardMaterial('chordFillMat', scene);
            chordFillMat.emissiveColor = new B.Color3(tealCol[0] * 0.55, tealCol[1] * 0.55, tealCol[2] * 0.55);
            chordFillMat.diffuseColor = new B.Color3(0, 0, 0);
            chordFillMat.specularColor = new B.Color3(0, 0, 0);
            chordFillMat.alpha = CHORD_BOX_FILL_ALPHA;
            chordFillMat.backFaceCulling = false;
            chordFillMat.disableDepthWrite = true;
            chordFillMesh = B.MeshBuilder.CreatePlane('chordFill', { size: 1 }, scene);
            chordFillMesh.material = chordFillMat;
            chordFillMesh.position.y = OFFSCREEN_Y;
            chordFillMesh.parent = fretboardRoot;
            chordFillBuffer = new Float32Array(MAX_CHORDS_VISIBLE * 16);
            chordFillMesh.thinInstanceSetBuffer('matrix', chordFillBuffer, 16, false);
            chordFillMesh.thinInstanceCount = 0;
            chordFillMesh.renderingGroupId = 0;

            chordEdgeMat = new B.StandardMaterial('chordEdgeMat', scene);
            chordEdgeMat.emissiveColor = new B.Color3(tealCol[0] * 1.4, tealCol[1] * 1.4, tealCol[2] * 1.4);
            chordEdgeMat.diffuseColor = new B.Color3(0, 0, 0);
            chordEdgeMat.specularColor = new B.Color3(0, 0, 0);
            chordEdgeMat.alpha = CHORD_BOX_EDGE_ALPHA;
            chordEdgeMat.backFaceCulling = false;
            chordEdgeMat.disableDepthWrite = true;
            chordEdgeMesh = B.MeshBuilder.CreatePlane('chordEdge', { size: 1 }, scene);
            chordEdgeMesh.material = chordEdgeMat;
            chordEdgeMesh.position.y = OFFSCREEN_Y;
            chordEdgeMesh.parent = fretboardRoot;
            chordEdgeBuffer = new Float32Array(MAX_CHORDS_VISIBLE * 4 * 16);
            chordEdgeMesh.thinInstanceSetBuffer('matrix', chordEdgeBuffer, 16, false);
            chordEdgeMesh.thinInstanceCount = 0;
            chordEdgeMesh.renderingGroupId = 0;

            const fretWireMat = new B.StandardMaterial('fretWireMat', scene);
            fretWireMat.emissiveColor = new B.Color3(0.35, 0.42, 0.55);
            fretWireMat.diffuseColor = new B.Color3(0, 0, 0);
            fretWireMat.specularColor = new B.Color3(0, 0, 0);
            fretWireMat.backFaceCulling = false;
            for (let f = 1; f <= NFRETS; f++) {
                const x = fretX(f);
                const isMain = (f % 12 === 0) || (f === 5 || f === 7 || f === 9);
                const wire = B.MeshBuilder.CreateBox('fret' + f, {
                    width: isMain ? 1.5 * K : 0.8 * K,
                    height: 0.6 * K,
                    depth: boardDepth,
                }, scene);
                wire.position = new B.Vector3(x, 0.4 * K, (BEHIND - AHEAD) * 0.5 * TS);
                wire.material = fretWireMat;
                wire.parent = fretboardRoot;
            }

            const yBottomString = S_BASE;
            const fretLabelY = yBottomString - S_GAP * 1.4;
            const fretLabelZ = 0.5 * K;
            const fretLabelSize = 3 * K;
            const fretLabelDepth = 1.2 * K;

            const fontData = await loadFont();
            try { await loadEarcut(); } catch (e) { console.warn('[' + PLUGIN_ID + '] earcut load failed:', e); }
            if (fontData && B.MeshBuilder.CreateText && window.earcut) {
                for (let f = 1; f <= NFRETS; f++) {
                    const textMesh = B.MeshBuilder.CreateText('fretLbl_' + f, String(f), fontData, {
                        size: fretLabelSize,
                        resolution: 32,
                        depth: fretLabelDepth,
                    }, scene);
                    if (!textMesh) continue;
                    const mat = new B.StandardMaterial('fretLblMat_' + f, scene);
                    mat.emissiveColor = new B.Color3(0.60, 0.72, 0.80);
                    mat.diffuseColor = new B.Color3(0.1, 0.12, 0.14);
                    mat.specularColor = new B.Color3(0.3, 0.3, 0.3);
                    mat.specularPower = 64;
                    mat.backFaceCulling = false;
                    textMesh.material = mat;
                    textMesh.position = new B.Vector3(fretMid(f), fretLabelY, fretLabelZ);
                    textMesh.rotation.x = -Math.PI * 0.5;
                    textMesh.renderingGroupId = 1;
                    fretLabelPlanes.push({ plane: textMesh, f });
                }
            } else {
                console.warn('[' + PLUGIN_ID + '] CreateText unavailable, skipping fret labels');
            }

            for (let s = 0; s < DEFAULT_VIS_STR; s++) {
                const y = sY(s);
                const c = S_COL[s];
                const strMat = new B.StandardMaterial('strMat' + s, scene);
                strMat.emissiveColor = new B.Color3(c[0] * 0.85, c[1] * 0.85, c[2] * 0.85);
                strMat.diffuseColor = new B.Color3(0, 0, 0);
                strMat.specularColor = new B.Color3(0, 0, 0);
                strMat.backFaceCulling = false;
                const str = B.MeshBuilder.CreateBox('str' + s, {
                    width: SCALE,
                    height: STR_THICK,
                    depth: STR_THICK,
                }, scene);
                str.position = new B.Vector3(SCALE / 2, y, 0);
                str.material = strMat;
                str.parent = fretboardRoot;
                stringLineMeshes.push(str);
            }

            const spanY = (DEFAULT_VIS_STR - 1) * S_GAP + S_GAP * 1.05;
            const nutH = spanY * 1.06;
            const nutMidY = S_BASE + (DEFAULT_VIS_STR - 1) * S_GAP * 0.5;
            const nutLenX = 1.55 * K;
            const nutXC = -0.78 * K;
            const nutD = 0.95 * K;

            const nutMat = new B.StandardMaterial('nutMat', scene);
            nutMat.diffuseColor = new B.Color3(0.78, 0.76, 0.71);
            nutMat.emissiveColor = new B.Color3(0.32, 0.30, 0.27);
            nutMat.specularColor = new B.Color3(0.2, 0.2, 0.2);
            nutMat.backFaceCulling = false;
            const nut = B.MeshBuilder.CreateBox('nut', {
                width: nutLenX,
                height: nutH,
                depth: nutD,
            }, scene);
            nut.position = new B.Vector3(nutXC, nutMidY, -0.62 * K);
            nut.material = nutMat;
            nut.parent = fretboardRoot;

            const xHeadLeft = -6.85 * K;
            const headstockMat = new B.StandardMaterial('headstockMat', scene);
            headstockMat.diffuseColor = new B.Color3(0.38, 0.28, 0.18);
            headstockMat.emissiveColor = new B.Color3(0.06, 0.04, 0.025);
            headstockMat.specularColor = new B.Color3(0.05, 0.05, 0.05);
            headstockMat.backFaceCulling = false;
            const headstockWidth = (nutXC - nutLenX * 0.5) - xHeadLeft;
            const headstockCX = (xHeadLeft + (nutXC - nutLenX * 0.5)) * 0.5;
            const headstock = B.MeshBuilder.CreateBox('headstock', {
                width: headstockWidth,
                height: spanY * 1.12,
                depth: 1.05 * K,
            }, scene);
            headstock.position = new B.Vector3(headstockCX, nutMidY, -1.38 * K);
            headstock.material = headstockMat;
            headstock.parent = fretboardRoot;

            for (let s = 0; s < DEFAULT_VIS_STR; s++) {
                const c = S_COL[s];

                const mesh = B.MeshBuilder.CreateBox('note_s' + s, { width: NOTE_W, height: NOTE_H, depth: NOTE_D }, scene);
                const mat = new B.StandardMaterial('noteMat_s' + s, scene);
                mat.emissiveColor = new B.Color3(c[0] * 1.4, c[1] * 1.4, c[2] * 1.4);
                mat.diffuseColor = new B.Color3(c[0] * 0.3, c[1] * 0.3, c[2] * 0.3);
                mat.specularColor = new B.Color3(0, 0, 0);
                mat.backFaceCulling = false;
                mesh.material = mat;
                mesh.position.y = OFFSCREEN_Y;
                const buf = new Float32Array(MAX_PER_STRING * 16);
                mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
                mesh.thinInstanceCount = 0;
                mesh.parent = fretboardRoot;
                stringNoteMeshes.push(mesh);
                stringMatrixBuffers.push(buf);

                const hitMesh = B.MeshBuilder.CreateBox('hit_s' + s, { width: NOTE_W * 1.15, height: NOTE_H * 1.15, depth: NOTE_D * 1.15 }, scene);
                const hitMat = new B.StandardMaterial('hitMat_s' + s, scene);
                hitMat.emissiveColor = new B.Color3(Math.min(1, c[0] * 2.5 + 0.4), Math.min(1, c[1] * 2.5 + 0.4), Math.min(1, c[2] * 2.5 + 0.4));
                hitMat.diffuseColor = new B.Color3(c[0], c[1], c[2]);
                hitMat.specularColor = new B.Color3(0, 0, 0);
                hitMat.backFaceCulling = false;
                hitMesh.material = hitMat;
                hitMesh.position.y = OFFSCREEN_Y;
                const hitBuf = new Float32Array(MAX_PER_STRING * 16);
                hitMesh.thinInstanceSetBuffer('matrix', hitBuf, 16, false);
                hitMesh.thinInstanceCount = 0;
                hitMesh.parent = fretboardRoot;
                stringHitMeshes.push(hitMesh);
                stringHitBuffers.push(hitBuf);

                const susMesh = B.MeshBuilder.CreateBox('sus_s' + s, { width: SUS_W, height: SUS_H, depth: 1 }, scene);
                const susMat = new B.StandardMaterial('susMat_s' + s, scene);
                susMat.emissiveColor = new B.Color3(c[0] * 0.95, c[1] * 0.95, c[2] * 0.95);
                susMat.diffuseColor = new B.Color3(c[0] * 0.2, c[1] * 0.2, c[2] * 0.2);
                susMat.specularColor = new B.Color3(0, 0, 0);
                susMat.backFaceCulling = false;
                susMesh.material = susMat;
                susMesh.position.y = OFFSCREEN_Y;
                const susBuf = new Float32Array(MAX_PER_STRING * 16);
                susMesh.thinInstanceSetBuffer('matrix', susBuf, 16, false);
                susMesh.thinInstanceCount = 0;
                susMesh.parent = fretboardRoot;
                stringSusMeshes.push(susMesh);
                stringSusBuffers.push(susBuf);
            }

            beatMeasureMesh = B.MeshBuilder.CreateBox('beat_m', { width: SCALE, height: 0.5 * K, depth: 1.5 * K }, scene);
            const beatMMat = new B.StandardMaterial('beatMMat', scene);
            beatMMat.emissiveColor = new B.Color3(0.55, 0.65, 0.85);
            beatMMat.diffuseColor = new B.Color3(0, 0, 0);
            beatMMat.specularColor = new B.Color3(0, 0, 0);
            beatMMat.backFaceCulling = false;
            beatMeasureMesh.material = beatMMat;
            beatMeasureMesh.position.y = OFFSCREEN_Y;
            beatMeasureBuffer = new Float32Array(MAX_BEATS * 16);
            beatMeasureMesh.thinInstanceSetBuffer('matrix', beatMeasureBuffer, 16, false);
            beatMeasureMesh.thinInstanceCount = 0;
            beatMeasureMesh.parent = fretboardRoot;

            beatQuarterMesh = B.MeshBuilder.CreateBox('beat_q', { width: SCALE, height: 0.4 * K, depth: 0.8 * K }, scene);
            const beatQMat = new B.StandardMaterial('beatQMat', scene);
            beatQMat.emissiveColor = new B.Color3(0.18, 0.20, 0.26);
            beatQMat.diffuseColor = new B.Color3(0, 0, 0);
            beatQMat.specularColor = new B.Color3(0, 0, 0);
            beatQMat.backFaceCulling = false;
            beatQuarterMesh.material = beatQMat;
            beatQuarterMesh.position.y = OFFSCREEN_Y;
            beatQuarterBuffer = new Float32Array(MAX_BEATS * 16);
            beatQuarterMesh.thinInstanceSetBuffer('matrix', beatQuarterBuffer, 16, false);
            beatQuarterMesh.thinInstanceCount = 0;
            beatQuarterMesh.parent = fretboardRoot;

            for (let s = 0; s < DEFAULT_VIS_STR; s++) {
                shadowGen.addShadowCaster(stringNoteMeshes[s]);
                shadowGen.addShadowCaster(stringHitMeshes[s]);
                shadowGen.addShadowCaster(stringSusMeshes[s]);
            }

            try {
                pipeline = new B.DefaultRenderingPipeline('fx', true, scene, [camera]);
                pipeline.bloomEnabled = true;
                pipeline.bloomThreshold = 0.25;
                pipeline.bloomWeight = 1.2;
                pipeline.bloomKernel = 96;
                pipeline.bloomScale = 0.65;
                pipeline.fxaaEnabled = true;
                if (pipeline.imageProcessing) {
                    pipeline.imageProcessing.toneMappingEnabled = true;
                    pipeline.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
                    pipeline.imageProcessing.exposure = 1.1;
                    pipeline.imageProcessing.vignetteEnabled = true;
                    pipeline.imageProcessing.vignetteWeight = 2.0;
                    pipeline.imageProcessing.contrast = 1.15;
                }
                console.log('[' + PLUGIN_ID + '] _init: pipeline created');
            } catch (e) {
                console.warn('[' + PLUGIN_ID + '] DefaultRenderingPipeline failed:', e);
            }

            isReady = true;
            console.log('[' + PLUGIN_ID + '] _init: done, isReady=true');
        }

        function _draw(bundle) {
            if (destroyed || !isReady || !scene || !engine) return;
            const now = bundle.currentTime || 0;
            const notes = bundle.notes || [];
            const chords = bundle.chords || [];
            const beats = bundle.beats || [];
            nStr = Math.min(DEFAULT_VIS_STR, bundle.stringCount || 6);
            inverted = !!bundle.inverted;
            lefty = !!bundle.lefty;
            if (fretboardRoot) fretboardRoot.scaling.x = lefty ? -1 : 1;
            const mirX = lefty ? -1 : 1;

            const activeFrets = new Set();
            const ACTIVE_WIN = 2.0;
            for (let i = 0; i < (bundle.notes || []).length; i++) {
                const n = bundle.notes[i];
                if (n.t <= now) continue;
                if (n.t >= now + ACTIVE_WIN) break;
                const f = n.f | 0;
                if (f > 0) activeFrets.add(f);
            }
            for (let i = 0; i < (bundle.chords || []).length; i++) {
                const ch = bundle.chords[i];
                if (ch.t <= now) continue;
                if (ch.t >= now + ACTIVE_WIN) break;
                if (!ch.notes) continue;
                for (let j = 0; j < ch.notes.length; j++) {
                    const f = ch.notes[j].f | 0;
                    if (f > 0) activeFrets.add(f);
                }
            }

            if (laneOddMesh && laneEvenMesh) {
                let highwayIntensity = 0;
                for (let i = 0; i < (bundle.notes || []).length; i++) {
                    const n = bundle.notes[i];
                    if (n.t <= now) continue;
                    const dt = n.t - now;
                    if (dt >= AHEAD) break;
                    const intens = 1 - dt / AHEAD;
                    if (intens > highwayIntensity) highwayIntensity = intens;
                }
                for (let i = 0; i < (bundle.chords || []).length; i++) {
                    const ch = bundle.chords[i];
                    if (ch.t <= now) continue;
                    const dt = ch.t - now;
                    if (dt >= AHEAD) break;
                    const intens = 1 - dt / AHEAD;
                    if (intens > highwayIntensity) highwayIntensity = intens;
                }

                let oddCount = 0, evenCount = 0, divCount = 0;
                if (activeFrets.size > 0) {
                    let minF = NFRETS, maxF = 0;
                    activeFrets.forEach(f => { if (f > 0) { if (f < minF) minF = f; if (f > maxF) maxF = f; } });
                    let dMin = minF - 1;
                    let dMax = maxF;
                    const span = dMax - dMin;
                    if (span > LANE_SPAN) {
                        dMin = Math.round((dMin + dMax - LANE_SPAN) * 0.5);
                        dMax = dMin + LANE_SPAN;
                        if (dMax > NFRETS) { dMax = NFRETS; dMin = dMax - LANE_SPAN; }
                        if (dMin < 0) { dMin = 0; dMax = LANE_SPAN; }
                    } else if (span < LANE_SPAN) {
                        const need = LANE_SPAN - span;
                        dMax = Math.min(NFRETS, dMax + need);
                        if (dMax - dMin < LANE_SPAN) {
                            dMin = Math.max(0, dMin - (LANE_SPAN - (dMax - dMin)));
                        }
                    }
                    if (dMax < dMin) dMax = dMin;

                    const laneLen = TS * (AHEAD + BEHIND);
                    const laneZ = -laneLen * 0.5 + TS * BEHIND;
                    const laneY = 0.4 * K;
                    const laneOp = LANE_OP_BASE + highwayIntensity * LANE_OP_INT;
                    laneOddMat.alpha = laneOp;
                    laneEvenMat.alpha = laneOp;

                    const fLow = dMin + 1, fHi = dMax;
                    for (let f = fLow; f <= fHi; f++) {
                        const xl = fretX(f - 1);
                        const xr = fretX(f);
                        const laneW = Math.abs(xr - xl);
                        const cx = (xl + xr) * 0.5;
                        const isOdd = ((f - fLow) & 1) === 0;
                        if (isOdd) {
                            writeMatrix(laneOddBuffer, oddCount * 16, cx, laneY, laneZ, laneW, 1, laneLen, 1, 0);
                            oddCount++;
                        } else {
                            writeMatrix(laneEvenBuffer, evenCount * 16, cx, laneY, laneZ, laneW, 1, laneLen, 1, 0);
                            evenCount++;
                        }
                    }

                    if (laneDividerMesh && laneDividerMat && highwayIntensity > 0.05) {
                        const divOp = 0.20 + highwayIntensity * 0.5;
                        laneDividerMat.alpha = Math.min(0.95, divOp);
                        const eMul = 1.0 + highwayIntensity * 2.0;
                        laneDividerMat.emissiveColor.r = 0.35 * eMul;
                        laneDividerMat.emissiveColor.g = 0.70 * eMul;
                        laneDividerMat.emissiveColor.b = 1.4 * eMul;
                        const yDiv = laneY + 0.05 * K;
                        for (let f = dMin; f <= dMax; f++) {
                            writeMatrix(laneDividerBuffer, divCount * 16, fretX(f), yDiv, laneZ, 1, 1, laneLen, 1, 0);
                            divCount++;
                        }
                    }
                }

                laneOddMesh.thinInstanceCount = oddCount;
                if (oddCount > 0) laneOddMesh.thinInstanceBufferUpdated('matrix');
                laneEvenMesh.thinInstanceCount = evenCount;
                if (evenCount > 0) laneEvenMesh.thinInstanceBufferUpdated('matrix');
                if (laneDividerMesh) {
                    laneDividerMesh.thinInstanceCount = divCount;
                    if (divCount > 0) laneDividerMesh.thinInstanceBufferUpdated('matrix');
                }
            }

            for (let i = 0; i < fretLabelPlanes.length; i++) {
                const entry = fretLabelPlanes[i];
                const isActive = activeFrets.has(entry.f);
                const mat = entry.plane.material;
                if (isActive) {
                    mat.emissiveColor.r = 1.0;
                    mat.emissiveColor.g = 0.91;
                    mat.emissiveColor.b = 0.30;
                    mat.alpha = 1.0;
                    entry.plane.scaling.x = 1.35;
                    entry.plane.scaling.y = 1.35;
                } else {
                    mat.emissiveColor.r = 0.60;
                    mat.emissiveColor.g = 0.72;
                    mat.emissiveColor.b = 0.80;
                    mat.alpha = 0.55;
                    entry.plane.scaling.x = 1.0;
                    entry.plane.scaling.y = 1.0;
                }
                entry.plane.position.x = fretMid(entry.f) * mirX;
            }
            const getNoteState = (typeof bundle.getNoteState === 'function') ? bundle.getNoteState : null;

            const dtSec = Math.max(1e-4, (engine.getDeltaTime() || 16.7) / 1000);
            _camComputeTargets(bundle, dtSec);
            _camUpdate(bundle);

            const noteCounts = new Array(MAX_STRINGS).fill(0);
            const hitCounts = new Array(MAX_STRINGS).fill(0);
            const susCounts = new Array(MAX_STRINGS).fill(0);

            const NOTE_LINGER = 0.10;
            const CHORD_LINGER = 0.55;
            const OPEN_SUS_OFFSET = NOTE_W * 3;

            const writeNote = (s, f, t, sus, chartTime, linger, fromChord, openX, openWScale) => {
                if (s < 0 || s >= nStr) return;
                const dt = (t || 0) - now;
                if (dt > AHEAD) return;

                const susVal = sus || 0;
                const susEndTime = (t || 0) + susVal;
                const sustained = dt < 0 && susVal > 0 && now <= susEndTime;
                const lingerDeadline = sustained ? susEndTime : (t || 0) + linger;
                if (now > lingerDeadline) return;

                const isOpen = (f === 0);
                const x = isOpen ? (openX != null ? openX : curX) : fretMid(f);
                const y = sY(s);
                const rawZ = -dt * TS;
                const z = sustained ? 0 : Math.min(0, rawZ);

                let state = null;
                if (getNoteState) {
                    const fakeNote = { t: t, s: s, f: f, sus: sus };
                    try { state = getNoteState(fakeNote, chartTime != null ? chartTime : t); }
                    catch (e) { state = null; }
                }
                const isHit = state && (state.state === 'hit' || state.state === 'active');

                const angle = (isOpen || dt <= 0) ? 0 : (Math.max(0, Math.min(1, dt / AHEAD)) * Math.PI * 0.5);
                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);
                const openXScale = (openWScale != null && openWScale > 0) ? openWScale : 1;
                const sx = isOpen ? OPEN_SCALE_X * openXScale : 1;
                const sy = isOpen ? OPEN_SCALE_Y : 1;
                const sz = isOpen ? OPEN_SCALE_Z : FRETTED_SCALE_Z;

                if (isHit) {
                    if (hitCounts[s] < MAX_PER_STRING) {
                        const idx = hitCounts[s] * 16;
                        writeMatrix(stringHitBuffers[s], idx, x, y, z, sx, sy, sz, cosA, sinA);
                        hitCounts[s]++;
                    }
                } else {
                    if (noteCounts[s] < MAX_PER_STRING) {
                        const idx = noteCounts[s] * 16;
                        writeMatrix(stringMatrixBuffers[s], idx, x, y, z, sx, sy, sz, cosA, sinA);
                        noteCounts[s]++;
                    }
                }

                const skipSus = fromChord && isOpen;
                if (susVal > 0.04 && !skipSus) {
                    const susEndDt = susEndTime - now;
                    const susEndZ = Math.min(0, -susEndDt * TS);
                    const farZ = Math.min(z, susEndZ);
                    const nearZ = Math.max(z, susEndZ);
                    const susLen = nearZ - farZ;
                    if (susLen > 1e-3) {
                        const susCenterZ = (farZ + nearZ) * 0.5;
                        const susYOff = y - NOTE_H * 0.25;
                        if (isOpen) {
                            if (susCounts[s] + 1 < MAX_PER_STRING) {
                                writeMatrix(stringSusBuffers[s], susCounts[s] * 16, x - OPEN_SUS_OFFSET, susYOff, susCenterZ, 1, 1, susLen, 1, 0);
                                susCounts[s]++;
                                writeMatrix(stringSusBuffers[s], susCounts[s] * 16, x + OPEN_SUS_OFFSET, susYOff, susCenterZ, 1, 1, susLen, 1, 0);
                                susCounts[s]++;
                            }
                        } else if (susCounts[s] < MAX_PER_STRING) {
                            writeMatrix(stringSusBuffers[s], susCounts[s] * 16, x, susYOff, susCenterZ, 1, 1, susLen, 1, 0);
                            susCounts[s]++;
                        }
                    }
                }
            };

            for (let i = 0; i < notes.length; i++) {
                const n = notes[i];
                const f = n.f | 0;
                let openX = curX;
                if (f === 0) {
                    const stable = _stableOpenX(n.t, notes, chords);
                    if (stable != null) openX = stable;
                }
                writeNote(n.s | 0, f, n.t, n.sus, n.t, NOTE_LINGER, false, openX);
            }
            const OPEN_NOTE_WORLD_W = 40 * K;
            for (let i = 0; i < chords.length; i++) {
                const ch = chords[i];
                if (!ch || !ch.notes) continue;
                let cxL = Infinity, cxR = -Infinity, frettedCount = 0;
                let fMinC = NFRETS, fMaxC = 0, anyFrettedC = false;
                for (let j = 0; j < ch.notes.length; j++) {
                    const fJ = ch.notes[j].f | 0;
                    if (fJ > 0) {
                        const fx = fretMid(fJ);
                        if (fx < cxL) cxL = fx;
                        if (fx > cxR) cxR = fx;
                        frettedCount++;
                        if (fJ < fMinC) fMinC = fJ;
                        if (fJ > fMaxC) fMaxC = fJ;
                        anyFrettedC = true;
                    }
                }
                const frettedCX = frettedCount > 0 ? (cxL + cxR) * 0.5 : curX;

                let bxL, bxR;
                if (anyFrettedC) {
                    const padX = NOTE_W * 0.4;
                    bxL = fretX(Math.max(0, fMinC - 1)) - padX;
                    bxR = fretX(Math.max(fMaxC, fMinC + 2)) + padX;
                } else {
                    bxL = curX - OPEN_NOTE_WORLD_W * 0.5;
                    bxR = curX + OPEN_NOTE_WORLD_W * 0.5;
                }
                const chordBoxW = Math.max(1e-6, bxR - bxL);
                const openWScale = Math.max(0.22, (chordBoxW * 0.96) / OPEN_NOTE_WORLD_W);

                const openHalfW = OPEN_NOTE_WORLD_W * openWScale * 0.5;
                const boxCx = (bxL + bxR) * 0.5;
                let chordCX = frettedCX;
                const safeMin = bxL + openHalfW;
                const safeMax = bxR - openHalfW;
                if (safeMin <= safeMax) {
                    if (chordCX < safeMin) chordCX = safeMin;
                    else if (chordCX > safeMax) chordCX = safeMax;
                } else {
                    chordCX = boxCx;
                }

                for (let j = 0; j < ch.notes.length; j++) {
                    const cn = ch.notes[j];
                    writeNote(cn.s | 0, cn.f | 0, ch.t, cn.sus, ch.t, CHORD_LINGER, true, chordCX, openWScale);
                }
            }

            let chordFillCount = 0, chordEdgeCount = 0;
            if (chordFillMesh && chordEdgeMesh) {
                const NW_PAD = NOTE_W * 0.4;
                const yA = sY(0);
                const yB_full = sY(nStr - 1);
                const yMinF = Math.min(yA, yB_full) - S_GAP * 0.8;
                const yMaxF = Math.max(yA, yB_full) + S_GAP * 0.8;
                const fullChordBoxH = yMaxF - yMinF;
                const ft = Math.max(CHORD_FRAME_RIM_MIN_K * K, fullChordBoxH * CHORD_FRAME_RIM_FRAC_H);

                for (let i = 0; i < chords.length; i++) {
                    const ch = chords[i];
                    if (!ch || !ch.notes) continue;
                    if (chordFillCount >= MAX_CHORDS_VISIBLE) break;
                    const chDt = (ch.t || 0) - now;
                    if (chDt > AHEAD) break;
                    if (chDt < -CHORD_LINGER) continue;

                    let fMin = NFRETS, fMax = 0, anyFretted = false;
                    let anyValid = false;
                    for (let j = 0; j < ch.notes.length; j++) {
                        const cn = ch.notes[j];
                        const sJ = cn.s | 0;
                        if (sJ < 0 || sJ >= nStr) continue;
                        anyValid = true;
                        const fJ = cn.f | 0;
                        if (fJ > 0) {
                            if (fJ < fMin) fMin = fJ;
                            if (fJ > fMax) fMax = fJ;
                            anyFretted = true;
                        }
                    }
                    if (!anyValid) continue;

                    let xL, xR;
                    if (anyFretted) {
                        xL = fretX(Math.max(0, fMin - 1)) - NW_PAD;
                        xR = fretX(Math.max(fMax, fMin + 2)) + NW_PAD;
                    } else {
                        let cxL = Infinity, cxR = -Infinity, cnt = 0;
                        for (let j = 0; j < ch.notes.length; j++) {
                            const fJ = ch.notes[j].f | 0;
                            if (fJ > 0) { const fx = fretMid(fJ); if (fx < cxL) cxL = fx; if (fx > cxR) cxR = fx; cnt++; }
                        }
                        const cxc = cnt > 0 ? (cxL + cxR) * 0.5 : curX;
                        const halfW = OPEN_SCALE_X * NOTE_W * 0.5;
                        xL = cxc - halfW;
                        xR = cxc + halfW;
                    }
                    const width = xR - xL;
                    if (width <= 0) continue;

                    const cx = (xL + xR) * 0.5;
                    const cY = (yMinF + yMaxF) * 0.5;
                    const height = fullChordBoxH;

                    const rawZ = -chDt * TS;
                    const z = Math.min(0, rawZ);

                    const fade = Math.max(0, 1 - chDt / AHEAD);
                    const lingerMul = chDt < 0 ? Math.max(0, 1 - (-chDt) / CHORD_LINGER) : 1;
                    const baseOp = fade * lingerMul;

                    const innerW = Math.max(width - 2 * ft, width * 0.45);
                    const innerH = Math.max(height - 2 * ft, height * 0.3);
                    writeMatrix(chordFillBuffer, chordFillCount * 16, cx, cY, z - 0.05 * K, innerW, innerH, 1, 1, 0);
                    chordFillCount++;

                    if (chordEdgeCount + 4 <= MAX_CHORDS_VISIBLE * 4) {
                        const yBot = yMinF;
                        const yTop = yMaxF;
                        writeMatrix(chordEdgeBuffer, chordEdgeCount * 16, cx, yBot + ft * 0.5, z, width, ft, 1, 1, 0);
                        chordEdgeCount++;
                        writeMatrix(chordEdgeBuffer, chordEdgeCount * 16, cx, yTop - ft * 0.5, z, width, ft, 1, 1, 0);
                        chordEdgeCount++;
                        const sideH = Math.max(yTop - yBot - 2 * ft, ft * 0.5);
                        const sideCy = (yTop + yBot) * 0.5;
                        writeMatrix(chordEdgeBuffer, chordEdgeCount * 16, xL + ft * 0.5, sideCy, z, ft, sideH, 1, 1, 0);
                        chordEdgeCount++;
                        writeMatrix(chordEdgeBuffer, chordEdgeCount * 16, xR - ft * 0.5, sideCy, z, ft, sideH, 1, 1, 0);
                        chordEdgeCount++;
                    }
                }
                chordFillMesh.thinInstanceCount = chordFillCount;
                if (chordFillCount > 0) chordFillMesh.thinInstanceBufferUpdated('matrix');
                chordEdgeMesh.thinInstanceCount = chordEdgeCount;
                if (chordEdgeCount > 0) chordEdgeMesh.thinInstanceBufferUpdated('matrix');
            }

            for (let s = 0; s < DEFAULT_VIS_STR; s++) {
                stringNoteMeshes[s].thinInstanceCount = noteCounts[s];
                if (noteCounts[s] > 0) stringNoteMeshes[s].thinInstanceBufferUpdated('matrix');
                stringHitMeshes[s].thinInstanceCount = hitCounts[s];
                if (hitCounts[s] > 0) stringHitMeshes[s].thinInstanceBufferUpdated('matrix');
                stringSusMeshes[s].thinInstanceCount = susCounts[s];
                if (susCounts[s] > 0) stringSusMeshes[s].thinInstanceBufferUpdated('matrix');
            }

            let mCount = 0, qCount = 0;
            for (let i = 0; i < beats.length; i++) {
                const b = beats[i];
                const dt = (b.time || 0) - now;
                if (dt < -BEHIND || dt > AHEAD) continue;
                const z = -dt * TS;
                if (b.measure === true || b.measure === 1) {
                    if (mCount < MAX_BEATS) {
                        const idx = mCount * 16;
                        writeMatrix(beatMeasureBuffer, idx, SCALE * 0.5, 0.6 * K, z, 1, 1, 1, 1, 0);
                        mCount++;
                    }
                } else {
                    if (qCount < MAX_BEATS) {
                        const idx = qCount * 16;
                        writeMatrix(beatQuarterBuffer, idx, SCALE * 0.5, 0.5 * K, z, 1, 1, 1, 1, 0);
                        qCount++;
                    }
                }
            }
            beatMeasureMesh.thinInstanceCount = mCount;
            if (mCount > 0) beatMeasureMesh.thinInstanceBufferUpdated('matrix');
            beatQuarterMesh.thinInstanceCount = qCount;
            if (qCount > 0) beatQuarterMesh.thinInstanceBufferUpdated('matrix');

            if (fpsOverlay) {
                const tNow = performance.now();
                if (tNow - fpsLastUpdate > 250) {
                    fpsOverlay.textContent = engine.getFps().toFixed(0) + ' FPS';
                    fpsLastUpdate = tNow;
                }
            }

            scene.render();
        }

        function _resize() {
            if (engine) engine.resize();
            if (engine && camera) {
                aspectScale = Math.max(1, REF_ASPECT / Math.max(engine.getAspectRatio(camera), 0.5));
            }
        }

        function _destroy() {
            destroyed = true;
            isReady = false;
            try {
                if (fpsOverlay && fpsOverlay.parentNode) fpsOverlay.parentNode.removeChild(fpsOverlay);
            } catch (e) { /* swallow */ }
            fpsOverlay = null;
            try {
                if (pipeline) { pipeline.dispose(); }
            } catch (e) { /* swallow */ }
            try {
                if (scene) { scene.dispose(); }
            } catch (e) { /* swallow */ }
            try {
                if (engine) { engine.dispose(); }
            } catch (e) { /* swallow */ }
            pipeline = null;
            scene = null;
            engine = null;
            camera = null;
            gizmoCam = null;
            fretboardRoot = null;
            stringLineMeshes = [];
            stringNoteMeshes = [];
            stringMatrixBuffers = [];
            stringSusMeshes = [];
            stringSusBuffers = [];
            stringHitMeshes = [];
            stringHitBuffers = [];
            beatMeasureMesh = null;
            beatMeasureBuffer = null;
            beatQuarterMesh = null;
            beatQuarterBuffer = null;
            fretLabelPlanes = [];
            laneOddMesh = null; laneOddMat = null; laneOddBuffer = null;
            laneEvenMesh = null; laneEvenMat = null; laneEvenBuffer = null;
            laneDividerMesh = null; laneDividerMat = null; laneDividerBuffer = null;
            chordFillMesh = null; chordFillMat = null; chordFillBuffer = null;
            chordEdgeMesh = null; chordEdgeMat = null; chordEdgeBuffer = null;
            B = null;
        }

        return {
            contextType: 'webgl2',
            init(canvas, _bundle) {
                destroyed = false;
                isReady = false;
                _init(canvas).catch(e => {
                    console.error('[' + PLUGIN_ID + '] init failed:', e);
                });
            },
            draw(bundle) {
                _draw(bundle);
            },
            resize(_w, _h) {
                _resize();
            },
            destroy() {
                _destroy();
            },
        };
    }

    window.slopsmithViz_highway_babylon = function () {
        return createInstance();
    };

    console.log('[' + PLUGIN_ID + '] viz factory registered');
})();
