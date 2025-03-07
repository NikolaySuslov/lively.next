/*global require, process*/

var lang = require('lively.lang');
var ast = require('../../lively.ast');
var classes = require('lively.classes');
var fs = require("fs");
var path = require("path");
var rollup = require('rollup');
var uglifyjs = require('uglify-es');
var babel = require('rollup-plugin-babel');


var targetFile1 = "dist/lively.morphic_no-deps.js";
var targetFile2 = "dist/lively.morphic.js";
var targetFile1Min = "dist/lively.morphic_no-deps.min.js";

var placeholderSrc = "throw new Error('Not yet read')";

var parts = {
  "lively.lang":             {source: placeholderSrc, path: require.resolve("lively.lang/dist/lively.lang.js")},
  "lively.graphics":         {source: placeholderSrc, path: require.resolve('lively.graphics/dist/lively.graphics.js')},
  "lively.serializer2":      {source: placeholderSrc, path: require.resolve('lively.serializer2/dist/lively.serializer2.js')},
  "lively.bindings":         {source: placeholderSrc, path: require.resolve('lively.bindings/dist/lively.bindings.js')},
  "virtual-dom":             {source: placeholderSrc, path: require.resolve('virtual-dom/dist/virtual-dom.js')},
  "vdom-parser":             {source: placeholderSrc, path: require.resolve('vdom-parser/dist.js')},
  "bowser":                  {source: placeholderSrc, path: require.resolve('bowser/bowser.min.js')},
  "web-animations-js":       {source: placeholderSrc, path: require.resolve('web-animations-js')},
  "bezier-easing":           {source: placeholderSrc, path: require.resolve('bezier-easing/dist/bezier-easing.min.js')},
  "flubber":                 {source: placeholderSrc, path: require.resolve('flubber')},
}
// output format - 'amd', 'cjs', 'es6', 'iife', 'umd'

if (!fs.existsSync('./dist')) {
  fs.mkdirSync('./dist');
}

const opts = {
  classHolder: {type: "Identifier", name: "_classRecorder"}, 
  functionNode: {type: "Identifier", name: "lively.classes.runtime.initializeClass"},
  currentModuleAccessor: ast.parse(`({
      pathInPackage: () => {
         return '/index.js'
      },
      subscribeToToplevelDefinitionChanges: () => () => {},
      package: () => { 
        return {
          name: "${JSON.parse(fs.readFileSync('./package.json')).name}",
          version: "${JSON.parse(fs.readFileSync('./package.json')).version}"
        } 
      } 
    })`).body[0].expression,
};

module.exports = Promise.resolve()
// 1. make sure deps are build
//.then(() => require("./build-kld-intersections.js"))
  // .then(() => require("./build-jsdom.js"))
  .then(() => {
    Object.keys(parts).forEach(name =>
      parts[name].source = fs.readFileSync(parts[name].path).toString());
 })
  .then(() => {
    console.log('rolling up...')
    return rollup.rollup({
      entry: "index.js",
      plugins: [
        {transform: (source, id) => {
            return ast.stringify(ast.transform.objectSpreadTransform(classes.classToFunctionTransform(source, opts)));
        }},
        babel({
          exclude: 'node_modules/**',
          sourceMap: false,
          babelrc: false,
          plugins: ['transform-exponentiation-operator', 'transform-async-to-generator', "syntax-object-rest-spread", "transform-object-rest-spread", "external-helpers"],
          presets: [["es2015", {"modules": false}]]
        })
      ]
    });
})
  .then(bundle => {
      const globals = {
        "vdom-parser": "vdomParser",
        "bowser": "bowser",
        "bezier-easing": "BezierEasing",
        "flubber": "flubber",
        "web-animations-js": "{}",
        "virtual-dom": "virtualDom",
        "lively.lang": "lively.lang",
        "lively.bindings": "lively.bindings",
        "lively.graphics": "lively.graphics",
        "lively.serializer2": "lively.serializer2",
        "lively.morphic": "lively.morphic",
        "lively.resources": "lively.resources",
        "lively.notifications": "lively.notifications",
        "lively.storage": "lively.storage",
        "lively.modules": "lively.modules", 
        "kld-intersections": "kldIntersections",
        // this is a temporary solution to make the runtime work for now
        "lively.halos": "{}",
        "lively.halos/morph.js": "{}",
        "lively.halos/drag-guides.js": "{}",
        "lively.halos/markers.js": "{}",
        "lively.halos/layout.js": "{}",
        
        "lively.ide/styling/gradient-editor.js": "{}",
        "lively.ide/service-worker.js": "{}",
        
        'lively.components': '{}',
        'lively.components/prompts.js': "{}",
        "lively.components/loading-indicator.js": "{}",
        "lively.components/canvas.js": "{}",
        'lively.components/buttons.js': "{}",
        'lively.components/menus.js': "{}", 
        'lively.components/list.js': "{}",
        'lively.components/widgets.js': "{}",
        "svgjs": "{}",
        "svg.easing.js": "{}",
        "svg.pathmorphing.js": "{}",
      };
      return bundle.generate({
         format: 'iife',
         name: 'lively.morphic',
         moduleName: 'lively.morphic',
         globals: globals,
       });
  })

  // remove kld intersections from core module

  // remove bowser?

  // 3. massage code a little
  .then((bundled)=> {
    console.log("massging code...")
    var origSource = bundled.code;
     // remove the mangling that rollup performs
    let varName, m, mangled = [];
    while (m = origSource.match(/^var \S*\$1 = function \(/m)) {
      varName = m[0].replace('var ', '').replace(' = function (', '');
      m = varName.replace('$$1', '').replace('$1', '');
      origSource = origSource.replace(new RegExp(varName.replace(/\$/g, '\\$'), 'g'), () => m);
      mangled.push(varName);
    }

  //console.log(mangled);
  
    var wrapInOwnDeps = (source) => `
${parts["web-animations-js"].source}\n
(function() {
  ${parts["bowser"].source}\n
  ${parts["virtual-dom"].source}\n
  ${parts['vdom-parser'].source}\n
  var GLOBAL = typeof window !== "undefined" ? window :
      typeof global!=="undefined" ? global :
        typeof self!=="undefined" ? self : this;
  GLOBAL.bezier = {default: (function() { var module = {}; ${parts['bezier-easing'].source} return module})().exports};
  (function() { var exports = {}; ${parts['flubber'].source} return exports})()
  System.global._classRecorder = {};
  ${source}
  if (typeof module !== "undefined" && typeof require === "function") module.exports = GLOBAL.lively.morphic;
})();`;

    var noDeps = wrapInOwnDeps(origSource);

    var complete = [
      "lively.lang",
      "lively.graphics",
      "lively.serializer2",
      "lively.bindings"
].map(key => {
  return `
// INLINED ${parts[key].path}
${parts[key].source}
// INLINED END ${parts[key].path}`
}).join("\n") + "\n" + noDeps;

    return {noDeps: noDeps, complete: complete};
  })

  // 4. create files
  .then(sources => {
    console.log("writing files...")
    fs.writeFileSync(targetFile1, sources.noDeps);
    fs.writeFileSync(targetFile2, sources.complete);
    fs.writeFileSync(targetFile1.replace('.js', '.min.js'), uglifyjs.minify(sources.noDeps, {keep_fnames: true}).code); 
    fs.writeFileSync(targetFile2.replace('.js', '.min.js'), uglifyjs.minify(sources.complete, {keep_fnames: true}).code); 
})
