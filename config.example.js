/* -----------------------------------------------------------------------------
 * CuacaMY — local configuration template
 *
 * 1. Copy this file to `config.js` (which is git-ignored, so your keys stay out
 *    of version control).
 * 2. Fill in the values you need. Everything is optional: with no config at all
 *    the dashboard runs on bundled demo data and local accounts.
 *
 *   cp config.example.js config.js
 * -------------------------------------------------------------------------- */

export default {
  /* ---------------------------------------------------------------------
   * OpenWeatherMap — https://openweathermap.org/api  (free tier is enough)
   * A brand-new key can take up to two hours to activate.
   * For a public deployment, restrict the key to your domain in the OWM
   * dashboard: a key shipped in front-end code is readable by anyone.
   * ------------------------------------------------------------------- */
  openWeatherKey: '',

  /* ---------------------------------------------------------------------
   * Firebase — optional. Supplying this switches the app from local
   * browser accounts to real Firebase Authentication (email/password and
   * Google sign-in) with saved places synced to Cloud Firestore.
   *
   * Firebase console -> Project settings -> Your apps -> Web app -> Config
   * These values are not secrets; your security comes from Firebase
   * Authorized Domains plus Firestore security rules (see README).
   * ------------------------------------------------------------------- */
  firebase: null,
  // firebase: {
  //   apiKey: 'AIza...',
  //   authDomain: 'your-project.firebaseapp.com',
  //   projectId: 'your-project',
  //   storageBucket: 'your-project.appspot.com',
  //   messagingSenderId: '000000000000',
  //   appId: '1:000000000000:web:abcdef'
  // },

  /* ---------------------------------------------------------------------
   * Google sign-in WITHOUT Firebase.
   *
   * An OAuth 2.0 Web client ID is all "Sign in with Google" actually needs:
   * free, no billing account, no Firebase project. Create one at
   * https://console.cloud.google.com/apis/credentials and authorise your
   * site's origin (e.g. https://yourname.github.io) under both
   * "Authorised JavaScript origins" and "Authorised redirect URIs".
   *
   * A client ID is a public identifier, not a secret — it is meant to be
   * visible in the page, and it only works from the origins you authorised.
   *
   * You can also paste this into the in-app setup wizard instead: open the
   * account dialog and press "Set up Google sign-in".
   * ------------------------------------------------------------------- */
  googleClientId: '',
  // googleClientId: '1234567890-abcdefg.apps.googleusercontent.com',

  /* ---------------------------------------------------------------------
   * The account that may open the admin database panel. Leave blank and the
   * first account created on a device owns it.
   * ------------------------------------------------------------------- */
  adminEmail: '',

  /* Optional Google Maps Platform key. The app's map links work without it. */
  googleMapsKey: '',

  /* The location shown on a first visit. */
  defaultCity: {
    name: 'Kuala Lumpur',
    state: 'W.P. Kuala Lumpur',
    country: 'MY',
    lat: 3.1390,
    lon: 101.6869
  }
};
