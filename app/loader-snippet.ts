export const getLoaderHtml = (visibleByDefault = true) => `
  <div class="pk-loader-overlay${visibleByDefault ? "" : " pk-loader-hidden"}" id="pk-loader-overlay">
    <div class="pk-loader-inner">
      <div class="pk-loader-cat-fallback" id="pk-loader-fallback">
        <div class="pk-cat-spinner-box">
          <svg class="pk-cat-spinner-svg" viewBox="0 0 80 80" width="76" height="76" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="40" cy="40" r="35" stroke="#F4F4F5" stroke-width="4"/>
            <circle cx="40" cy="40" r="35" stroke="#FFE600" stroke-width="4" stroke-dasharray="140" stroke-dashoffset="35" stroke-linecap="round" class="pk-spin-ring"/>
            <!-- Cat head shape -->
            <path d="M26 34 L32 20 L40 28 L48 20 L54 34 C58 40 58 50 54 56 C50 62 30 62 26 56 C22 50 22 40 26 34 Z" fill="#121217"/>
            <!-- Cat ears inner -->
            <path d="M31 25 L34 32 L28 32 Z" fill="#FFE600"/>
            <path d="M49 25 L52 32 L46 32 Z" fill="#FFE600"/>
            <!-- Cat eyes -->
            <ellipse cx="33" cy="42" rx="3" ry="3.5" fill="#FFE600"/>
            <ellipse cx="47" cy="42" rx="3" ry="3.5" fill="#FFE600"/>
            <ellipse cx="33.8" cy="42" rx="1.4" ry="2.2" fill="#121217"/>
            <ellipse cx="47.8" cy="42" rx="1.4" ry="2.2" fill="#121217"/>
            <!-- Cat nose & mouth -->
            <path d="M38.5 48 L41.5 48 L40 50 Z" fill="#ffffff"/>
            <path d="M37 52 Q40 54 43 52" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" fill="none"/>
            <!-- Whiskers -->
            <path d="M21 44 L29 45 M21 48 L29 48 M51 45 L59 44 M51 48 L59 48" stroke="#FFE600" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="pk-loader-brand">PURRKINS</div>
        <div class="pk-loader-caption">Loading kitten's dashboard...</div>
      </div>
      <video class="pk-loader-video pk-loader-desktop" autoplay loop muted playsinline preload="auto">
        <source src="/apps/purrkins/desktop-loader.mp4" type="video/mp4">
      </video>
      <video class="pk-loader-video pk-loader-mobile" autoplay loop muted playsinline preload="auto">
        <source src="/apps/purrkins/mobile-loader.mp4" type="video/mp4">
      </video>
    </div>
  </div>

  <style>
    #header-group,
    .shopify-section-group-header-group,
    .site-header {
      position: sticky !important;
      top: 0 !important;
      z-index: 999999 !important;
    }

    .pk-loader-overlay {
      position: fixed;
      top: var(--header-group-height, 105px);
      left: 0;
      right: 0;
      bottom: 0;
      width: 100vw;
      height: calc(100vh - var(--header-group-height, 105px));
      background-color: #ffffff;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 1;
      visibility: visible;
      transition: opacity 0.35s ease, visibility 0.35s ease;
    }
    .pk-loader-overlay.pk-loader-hidden {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .pk-loader-inner {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
    }
    .pk-loader-cat-fallback {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      z-index: 1;
      user-select: none;
    }
    .pk-cat-spinner-box {
      width: 80px;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 12px;
    }
    .pk-spin-ring {
      animation: pkSpinnerRotate 1.25s linear infinite;
      transform-origin: 40px 40px;
    }
    @keyframes pkSpinnerRotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .pk-loader-brand {
      font-family: var(--font-heading--family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 2px;
      color: #121217;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .pk-loader-caption {
      font-family: var(--font-body--family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 13px;
      font-weight: 600;
      color: #71717a;
    }
    .pk-loader-video {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2;
      display: block;
      object-fit: contain;
      background: transparent;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .pk-loader-video.pk-video-ready {
      opacity: 1;
    }
    .pk-loader-desktop {
      width: 420px;
      max-width: 90vw;
      max-height: 70vh;
      height: auto;
    }
    .pk-loader-mobile {
      display: none;
      width: 260px;
      max-width: 85vw;
      max-height: 70vh;
      height: auto;
    }
    @media (max-width: 768px) {
      .pk-loader-overlay {
        top: var(--header-group-height, 95px);
        height: calc(100vh - var(--header-group-height, 95px));
      }
      .pk-loader-desktop {
        display: none !important;
      }
      .pk-loader-mobile {
        display: block !important;
      }
    }
  </style>

  <script>
    (function() {
      function pkAdjustLoaderPosition() {
        var hg = document.getElementById('header-group') || document.querySelector('.site-header') || document.querySelector('header');
        if (hg) {
          var h = hg.offsetHeight || hg.getBoundingClientRect().height || 0;
          if (h > 0) {
            document.documentElement.style.setProperty('--header-group-height', h + 'px');
            if (document.body) {
              document.body.style.setProperty('--header-group-height', h + 'px');
            }
            var overlays = document.querySelectorAll('.pk-loader-overlay');
            for (var i = 0; i < overlays.length; i++) {
              overlays[i].style.top = h + 'px';
              overlays[i].style.height = 'calc(100vh - ' + h + 'px)';
            }
          }
        }
      }

      function pkShowLoader() {
        pkAdjustLoaderPosition();
        var overlays = document.querySelectorAll('.pk-loader-overlay');
        for (var i = 0; i < overlays.length; i++) {
          overlays[i].style.display = 'flex';
          overlays[i].classList.remove('pk-loader-hidden');
          var vids = overlays[i].querySelectorAll('video');
          for (var j = 0; j < vids.length; j++) {
            if (vids[j].paused) {
              vids[j].play().catch(function(){});
            }
          }
        }
      }

      function pkHideLoader() {
        var overlays = document.querySelectorAll('.pk-loader-overlay');
        for (var i = 0; i < overlays.length; i++) {
          overlays[i].classList.add('pk-loader-hidden');
          (function(el) {
            setTimeout(function() {
              if (el && el.classList.contains('pk-loader-hidden')) {
                el.style.display = 'none';
              }
            }, 350);
          })(overlays[i]);
        }
      }

      // Attach video ready listeners to show video once first frame renders
      function initVideos() {
        var vids = document.querySelectorAll('.pk-loader-video');
        vids.forEach(function(v) {
          function markReady() {
            v.classList.add('pk-video-ready');
          }
          if (v.readyState >= 2) {
            markReady();
          } else {
            v.addEventListener('loadeddata', markReady);
            v.addEventListener('playing', markReady);
            v.addEventListener('canplay', markReady);
          }
          v.play().catch(function(){});
        });
      }

      window.pkShowLoader = pkShowLoader;
      window.pkHideLoader = pkHideLoader;
      window.purrkinsShowLoader = pkShowLoader;
      window.purrkinsHideLoader = pkHideLoader;
      window.pkAdjustLoaderPosition = pkAdjustLoaderPosition;

      // Adjust right away and on events
      pkAdjustLoaderPosition();
      initVideos();
      window.addEventListener('resize', pkAdjustLoaderPosition);
      if (window.ResizeObserver) {
        var hg = document.getElementById('header-group');
        if (hg) {
          new ResizeObserver(pkAdjustLoaderPosition).observe(hg);
        }
      }

      // Generous safety failsafe timeout only: never trap the user permanently
      setTimeout(pkHideLoader, 6000);
    })();
  </script>
`;
