/*global require, process*/

var fs = require("fs");
var path = require("path");
var rollup = require('rollup');
var babel = require('rollup-plugin-babel');

var targetFile = "dist/lively.classes.js";

if (!fs.existsSync('./dist')) {
  fs.mkdirSync('./dist');
}

// output format - 'amd', 'cjs', 'es6', 'iife', 'umd'
module.exports = Promise.resolve()

  .then(() => rollup.rollup({
    entry: "index.js",
    plugins: [
      babel({
        exclude: 'node_modules/**', sourceMap: false,
        "presets": [["es2015", {modules: false}]],
        "plugins": ['transform-async-to-generator', "syntax-object-rest-spread", "transform-object-rest-spread", "external-helpers"],
        babelrc: false
      })]
  }))

  .then(bundle =>
    bundle.generate({
      format: 'iife',
      moduleName: 'lively.classes',
      globals: {
        "lively.lang": "lively.lang",
        "lively.ast": "lively.ast",
        "module": "typeof module !== 'undefined' ? module.constructor : {}"
      },
    }))

  // 3. massage code a little
  .then(bundled => {
    return `
;(function() {
  var GLOBAL = typeof window !== "undefined" ? window :
      typeof global!=="undefined" ? global :
        typeof self!=="undefined" ? self : this;
  if (typeof lively.lang === "undefined") GLOBAL.lively.lang = {};
})();
(function() {
  var GLOBAL = typeof window !== "undefined" ? window :
      typeof global!=="undefined" ? global :
        typeof self!=="undefined" ? self : this;
  ${bundled.code}
  if (typeof module !== "undefined" && module.exports) module.exports = GLOBAL.lively.classes;
})();`;
  })

  // 4. inject dependencies
  .then(source => {
    fs.writeFileSync(targetFile, source);
  })
  .catch(err => { console.error(err.stack || err); throw err; })
