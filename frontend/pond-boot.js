(function () {
  'use strict';

  const sources = [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'pond3d.js?v=3.2.0',
    'pond-runtime-v2.js?v=3.2.0',
  ];

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const absoluteSource = new URL(source, document.baseURI).href;
      let executionError = null;

      function captureExecutionError(event) {
        if (event.filename && new URL(event.filename, document.baseURI).href !== absoluteSource) return;
        executionError = event.error || new Error(event.message || `Could not execute ${source}`);
        event.preventDefault();
      }

      function cleanup() {
        removeEventListener('error', captureExecutionError);
      }

      script.async = false;
      script.src = source;
      script.addEventListener('load', () => {
        cleanup();
        if (executionError) reject(executionError);
        else resolve();
      }, { once: true });
      script.addEventListener('error', () => {
        cleanup();
        reject(new Error(`Could not load ${source}`));
      }, { once: true });
      addEventListener('error', captureExecutionError);
      document.body.appendChild(script);
    });
  }

  function startFallback(message) {
    window.__pondRenderer = 'canvas';
    try {
      window.EternalPondCanvasV2.start(message);
    } catch (error) {
      const status = document.querySelector('#loading-screen .loading-status');
      const bar = document.querySelector('#loading-screen .loading-bar');
      if (status) status.textContent = 'this device could not open the pond';
      if (bar) bar.hidden = true;
      console.warn('Eternal Pond fallback could not start', error);
    }
  }

  async function boot() {
    const forcedCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
    if (forcedCanvas) {
      startFallback('the pond opened in its simpler view');
      return;
    }

    try {
      for (const source of sources) {
        await loadScript(source);
        if (window.__pondWebGLFailure) throw window.__pondWebGLFailure;
      }
      window.__pondRenderer = 'webgl';
    } catch (error) {
      startFallback('a simpler pond opened for this device');
    }
  }

  boot();
}());
