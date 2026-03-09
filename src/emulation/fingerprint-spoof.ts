import type { FingerprintProfile } from '../shared/types.js';

/**
 * Builds a JS string for context.addInitScript() that spoofs browser fingerprint
 * to look like a real CTV device instead of headless Chrome on a server.
 */
export function buildFingerprintScript(fp: FingerprintProfile): string {
  return `
(function() {
  // --- navigator.platform ---
  Object.defineProperty(Navigator.prototype, 'platform', {
    get: function() { return ${JSON.stringify(fp.platform)}; }
  });

  // --- navigator.hardwareConcurrency ---
  Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
    get: function() { return ${fp.hwConcurrency}; }
  });

  // --- navigator.deviceMemory ---
  Object.defineProperty(Navigator.prototype, 'deviceMemory', {
    get: function() { return ${fp.deviceMemory}; }
  });

  // --- navigator.maxTouchPoints ---
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
    get: function() { return ${fp.maxTouchPoints}; }
  });

  // --- navigator.plugins (empty for TV) ---
  Object.defineProperty(Navigator.prototype, 'plugins', {
    get: function() { return []; }
  });

  // --- navigator.webdriver = false ---
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: function() { return false; }
  });

  // --- navigator.connection ---
  var connData = ${JSON.stringify(fp.connection)};
  if ('connection' in Navigator.prototype || navigator.connection) {
    Object.defineProperty(Navigator.prototype, 'connection', {
      get: function() { return connData; }
    });
  } else {
    Object.defineProperty(navigator, 'connection', {
      get: function() { return connData; },
      configurable: true
    });
  }

  // --- screen properties ---
  Object.defineProperty(screen, 'colorDepth', {
    get: function() { return ${fp.screen.colorDepth}; }
  });
  Object.defineProperty(screen, 'pixelDepth', {
    get: function() { return ${fp.screen.pixelDepth}; }
  });
  // availWidth/availHeight = full screen (no taskbar on TV)
  Object.defineProperty(screen, 'availWidth', {
    get: function() { return screen.width; }
  });
  Object.defineProperty(screen, 'availHeight', {
    get: function() { return screen.height; }
  });

  // --- window.devicePixelRatio ---
  Object.defineProperty(window, 'devicePixelRatio', {
    get: function() { return 1; }
  });

  // --- Canvas fingerprint noise ---
  var canvasSeed = ${fp.canvasNoiseSeed};
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    var ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        var imgData = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
        var data = imgData.data;
        // Deterministic noise based on seed
        var s = canvasSeed;
        for (var i = 0; i < data.length; i += 4) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          data[i] = (data[i] + (s % 3) - 1) & 0xff;
        }
        ctx.putImageData(imgData, 0, 0);
      } catch(e) {}
    }
    return origToDataURL.call(this, type, quality);
  };

  // --- WebGL vendor/renderer ---
  var origGetParameter = WebGLRenderingContext.prototype.getParameter;
  var webglVendor = ${JSON.stringify(fp.webgl.vendor)};
  var webglRenderer = ${JSON.stringify(fp.webgl.renderer)};
  WebGLRenderingContext.prototype.getParameter = function(param) {
    var ext = this.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      if (param === ext.UNMASKED_VENDOR_WEBGL) return webglVendor;
      if (param === ext.UNMASKED_RENDERER_WEBGL) return webglRenderer;
    }
    return origGetParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      var ext = this.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        if (param === ext.UNMASKED_VENDOR_WEBGL) return webglVendor;
        if (param === ext.UNMASKED_RENDERER_WEBGL) return webglRenderer;
      }
      return origGetParameter2.call(this, param);
    };
  }

  // --- AudioContext noise ---
  var audioSeed = ${fp.audioNoiseSeed};
  if (typeof AudioContext !== 'undefined') {
    var origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      var osc = origCreateOscillator.call(this);
      try {
        var gain = this.createGain();
        // Micro-noise in gain based on seed
        var noiseVal = ((audioSeed % 1000) / 1000000);
        gain.gain.value = 1.0 + noiseVal;
        osc.connect(gain);
      } catch(e) {}
      return osc;
    };
  }

  // --- Fonts ---
  var allowedFonts = ${JSON.stringify(fp.fonts)};
  if (document.fonts && document.fonts.check) {
    var origCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      for (var i = 0; i < allowedFonts.length; i++) {
        if (font.indexOf(allowedFonts[i]) !== -1) return true;
      }
      return false;
    };
  }

  // --- Storage estimate ---
  if (navigator.storage && navigator.storage.estimate) {
    var storageQuota = ${fp.storageQuota};
    navigator.storage.estimate = function() {
      return Promise.resolve({ usage: 0, quota: storageQuota });
    };
  }
})();
`;
}
