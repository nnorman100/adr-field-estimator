# Vendored Firebase SDK

Firebase JS SDK 13.0.0 modular builds (ES modules), served from Hosting so the app needs no npm or build step. Hosting does not publish this file. `app.js` loads them with `import()`; the Content Security Policy allows only same-origin scripts for them.

The CDN builds of `firebase-auth.js` and `firebase-app-check.js` import `https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js`. The vendored copies change only that import to `./firebase-app.js`, so every module stays on this origin and shares one `firebase-app.js` instance. `firebase-app.js` is unmodified. Rebuild a file only from the same release's source URL with that one change, then update both hashes here:

```sh
curl -sSfL https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js | sed 's#from"https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js"#from"./firebase-app.js"#' > firebase/13.0.0/firebase-auth.js
```

| File | Version | Source | Source SHA-256 | Vendored SHA-256 |
| --- | --- | --- | --- | --- |
| `firebase/13.0.0/firebase-app.js` | 13.0.0 | https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js | `7cb48cbc5728f220562d05bd0aab8c17d8bda03c599ad8cb4ad0f042e4f65765` | same |
| `firebase/13.0.0/firebase-auth.js` | 13.0.0 | https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js | `286224de4d870ef55e4301f718488fa77f146d60d6953b3a76f9a3883669b34a` | `4efb4436232a15e04a2f876628b872140a837f7167af8660fbf94d5247f480d1` |
| `firebase/13.0.0/firebase-app-check.js` | 13.0.0 | https://www.gstatic.com/firebasejs/13.0.0/firebase-app-check.js | `eb521d7ce76254e7f5aef24ec6b660452bc986028ff0efaba3476220b5a03472` | `f82bfa8484550dbf4666335d6477b60bc6bb123145dc5d748dd1a83167f1d187` |

The release is part of the path, so an upgrade gets new URLs and installed apps never mix cached files from two releases. To upgrade, vendor the new release into its own `firebase/<version>/` directory, delete the old one, and change the version in `FIREBASE_SDK` in `app.js`, the `modulepreload` links in both `index.html` copies and `ASSETS` in `sw.js`.

`app.js` loads the App Check build only when `APP_CHECK_SITE_KEY` is set; see [App Check](../../docs/app-check.md).
