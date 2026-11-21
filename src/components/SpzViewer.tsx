import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import './SpzViewer.css';

interface SpzViewerProps { spzUrl: string; }

export function SpzViewer({ spzUrl }: SpzViewerProps) {
  const viewerRootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [fov, setFov] = useState(85);
  const fovRef = useRef(fov);
  const [message, setMessage] = useState('Loading 3D model…');
  const [smoothMode, setSmoothMode] = useState(false);
  const smoothModeRef = useRef(false);
  const [fps, setFps] = useState(0);
  const [splatCount, setSplatCount] = useState(0);

  useEffect(() => { fovRef.current = fov; }, [fov]);
  useEffect(() => { smoothModeRef.current = smoothMode; }, [smoothMode]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090b0e');
    const camera = new THREE.PerspectiveCamera(85, 1, 0.05, 1000);
    const renderer = new WebGPURenderer({ antialias: true, forceWebGL: !navigator.gpu });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    host.append(renderer.domElement);

    let splat: GaussianSplat | undefined;
    let frameId = 0;
    let disposed = false;
    let dragging = false;
    let yaw = 0;
    let pitch = -0.12;
    let previous = performance.now();
    const velocity = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const keys = new Set<string>();
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      camera.aspect = Math.max(width, 1) / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    };
    const frameScene = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.42, 1);
      camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.18, radius * 2.2));
      const direction = center.clone().sub(camera.position);
      yaw = Math.atan2(-direction.x, -direction.z);
      pitch = Math.asin(THREE.MathUtils.clamp(direction.y / direction.length(), -1, 1));
      camera.near = Math.max(0.01, radius / 1000); camera.far = radius * 100; camera.updateProjectionMatrix();
    };
    const updateCamera = (delta: number) => {
      camera.fov = fovRef.current; camera.updateProjectionMatrix();
      // When upside down, preserve the user's screen-relative left/right
      // direction instead of reversing A and D.
      const screenUp = Math.cos(pitch) >= 0 ? 1 : -1;
      const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
      yaw += steer * screenUp * (smoothModeRef.current ? 0.36 : 1.45) * delta;
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      if (!splat) return;
      forward.set(0, 0, -1).applyQuaternion(camera.quaternion); desired.set(0, 0, 0);
      if (keys.has('KeyW')) desired.add(forward); if (keys.has('KeyS')) desired.sub(forward);
      if (keys.has('KeyE')) desired.y += 1; if (keys.has('KeyQ')) desired.y -= 1;
      const maxSpeed = smoothModeRef.current ? 1.15 : (keys.has('ShiftLeft') ? 18 : 6);
      if (desired.lengthSq()) desired.normalize().multiplyScalar(maxSpeed);
      const response = smoothModeRef.current ? 1.35 : (desired.lengthSq() ? 4.2 : 2.1);
      velocity.lerp(desired, 1 - Math.exp(-response * delta));
      camera.position.addScaledVector(velocity, delta);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        event.preventDefault();
        if (!event.repeat) setSmoothMode((enabled) => !enabled);
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft'].includes(event.code)) { event.preventDefault(); keys.add(event.code); }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'AltLeft' || event.code === 'AltRight') { event.preventDefault(); return; }
      keys.delete(event.code);
    };
    const onPointerDown = (event: PointerEvent) => { if (event.button === 0 && splat) { dragging = true; renderer.domElement.setPointerCapture(event.pointerId); } };
    const onPointerUp = () => { dragging = false; };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      // Do not clamp pitch: flight navigation must allow the camera to roll
      // through vertical. Flip horizontal yaw once inverted to avoid reversed drag.
      const screenUp = Math.cos(pitch) >= 0 ? 1 : -1;
      yaw -= event.movementX * 0.003 * screenUp;
      pitch -= event.movementY * 0.003;
    };
    const observer = new ResizeObserver(resize); observer.observe(host);
    // Fullscreen changes do not always trigger the host observer until after
    // layout settles, so queue a second measurement for the canvas.
    const onFullscreenChange = () => requestAnimationFrame(resize);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    renderer.domElement.addEventListener('pointerdown', onPointerDown); renderer.domElement.addEventListener('pointerup', onPointerUp); renderer.domElement.addEventListener('pointercancel', onPointerUp); renderer.domElement.addEventListener('pointermove', onPointerMove);
    resize();
    let fpsFrames = 0;
    let fpsSampleStart = performance.now();
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, .05); previous = now;
      fpsFrames += 1;
      if (now - fpsSampleStart >= 500) {
        setFps(Math.round((fpsFrames * 1000) / (now - fpsSampleStart)));
        fpsFrames = 0; fpsSampleStart = now;
      }
      updateCamera(delta); renderer.renderAsync(scene, camera); frameId = requestAnimationFrame(animate);
    };
    const load = async () => {
      try {
        await renderer.init(); if (!spzUrl) throw new Error('No model URL was provided.');
        const response = await fetch(spzUrl); if (!response.ok) throw new Error(`The model request failed (${response.status}).`);
        setMessage('Parsing 3D model…');
        const geometry = await new SPZLoader().parse(await response.arrayBuffer());
        if (!geometry) throw new Error('The SPZ file did not contain renderable geometry.');
        if (disposed) return;
        setSplatCount(geometry.getAttribute('position')?.count ?? 0);
        splat = new GaussianSplat(geometry, { autoSort: true }); scene.add(splat); frameScene(splat); setMessage(''); frameId = requestAnimationFrame(animate);
      } catch (error) { console.error('[PRISM] Unable to load SPZ model:', error); if (!disposed) setMessage(error instanceof Error ? error.message : 'Unable to load the 3D model.'); }
    };
    setMessage('Loading 3D model…'); void load();
    return () => {
      disposed = true; cancelAnimationFrame(frameId); observer.disconnect(); document.removeEventListener('fullscreenchange', onFullscreenChange); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown); renderer.domElement.removeEventListener('pointerup', onPointerUp); renderer.domElement.removeEventListener('pointercancel', onPointerUp); renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [spzUrl]);

  const toggleFullscreen = async () => {
    if (!viewerRootRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewerRootRef.current.requestFullscreen();
  };

  return <div ref={viewerRootRef} className="spz-viewer-root" tabIndex={0}><div ref={canvasHostRef} className="spz-canvas-host" /><div className="spz-viewer-toolbar"><span className="spz-viewer-brand"><i />SPZ VIEWER</span><div className="spz-viewer-actions"><label className="spz-fov-control">FOV <output>{fov}°</output><input type="range" min="10" max="120" value={fov} onChange={(event) => setFov(Number(event.target.value))} /></label><button type="button" className="spz-fullscreen" onClick={() => void toggleFullscreen()}>Fullscreen</button></div></div>{message && <div className="spz-status">{message}</div>}{!message && <><div className="spz-flight-hint">Drag to look · W / S forward / back · A / D steer · Q / E altitude · Shift boost · Alt smooth: <b>{smoothMode ? 'on' : 'off'}</b></div><div className="spz-stats"><span>{splatCount.toLocaleString()} splats</span><span>{fps} FPS</span></div></>}</div>;
}
