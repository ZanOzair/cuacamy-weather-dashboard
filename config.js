/* -----------------------------------------------------------------------------
 * CuacaMY — runtime configuration
 *
 * This file ships blank on purpose so the app loads with no 404 and no setup.
 * Fill in only what you need; every field is optional.
 *
 *   • Just trying it out?  Leave this file alone and paste your OpenWeatherMap
 *     key into the in-app Settings dialog. It is stored in your browser only
 *     and never touches the repository.
 *
 *   • Deploying a live demo (GitHub Pages, Netlify…)?  A static site has no
 *     server to hide a key behind, so the key here will be public. That is
 *     normal and acceptable *provided you restrict it*: in the OpenWeatherMap
 *     dashboard, tie the key to your domain, and keep it on the free tier so a
 *     scraper cannot run up a bill.
 *
 * See config.example.js for the fully annotated template, including Firebase.
 * -------------------------------------------------------------------------- */

export default {
  openWeatherKey: '',
  firebase: null,
  googleMapsKey: ''
};
