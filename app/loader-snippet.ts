export const getLoaderHtml = (visibleByDefault = true) => `
  <div class="pk-loader-overlay${visibleByDefault ? "" : " pk-loader-hidden"}" id="pk-loader-overlay">
    <div class="pk-loader-inner">
      <video class="pk-loader-video pk-loader-desktop" autoplay loop muted playsinline preload="auto">
        <source src="/apps/purrkins/desktop-loader.mp4" type="video/mp4">
      </video>
      <video class="pk-loader-video pk-loader-mobile" autoplay loop muted playsinline preload="auto">
        <source src="/apps/purrkins/mobile-loader.mp4" type="video/mp4">
      </video>
    </div>
  </div>

  <style>
    .pk-loader-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background-color: #ffffff;
      z-index: 99999999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 1;
      visibility: visible;
      transition: opacity 0.35s ease, visibility 0.35s ease;
    }
    .pk-loader-overlay.pk-loader-hidden {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .pk-loader-inner {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
    }
    .pk-loader-video {
      display: block;
      object-fit: contain;
      background: transparent;
    }
    .pk-loader-desktop {
      width: 420px;
      max-width: 90vw;
      max-height: 80vh;
      height: auto;
    }
    .pk-loader-mobile {
      display: none;
      width: 260px;
      max-width: 85vw;
      max-height: 80vh;
      height: auto;
    }
    @media (max-width: 768px) {
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
      function pkShowLoader() {
        var overlays = document.querySelectorAll('.pk-loader-overlay');
        for (var i = 0; i < overlays.length; i++) {
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
        }
      }

      window.pkShowLoader = pkShowLoader;
      window.pkHideLoader = pkHideLoader;
      window.purrkinsShowLoader = pkShowLoader;
      window.purrkinsHideLoader = pkHideLoader;

      if (document.readyState === 'complete') {
        setTimeout(pkHideLoader, 150);
      } else {
        window.addEventListener('load', function() {
          setTimeout(pkHideLoader, 150);
        });
      }
      setTimeout(pkHideLoader, 3500);
    })();
  </script>
`;
