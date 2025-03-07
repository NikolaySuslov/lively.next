/*global System,origin, babel*/
import { resource } from "lively.resources";
import { isURL, join } from "lively.modules/src/url-helpers.js";
import { parent } from "lively.resources/src/helpers.js";
import { parse, stringify, transform, nodes, query } from "lively.ast";
import { findUniqJsName } from "./util.js";
import { string } from "lively.lang";
import { prepareCodeForCustomCompile, prepareTranslatedCodeForSetterCapture } from "lively.modules/src/instrumentation.js";
import { module } from "lively.modules/index.js";
import { rewriteToCaptureTopLevelVariables } from "lively.source-transform/capturing.js";
import objectSpreadTransform from "lively.ast/lib/object-spread-transform.js";
import { es5Transpilation } from "lively.source-transform";

function exportCall(exportName, id) {
  return stringify(
    nodes.exprStmt(
      nodes.funcCall(nodes.id("_export"), nodes.literal(exportName), id)))
}

export function asyncAwaitTranspilation(source) {
    if (typeof babel === 'undefined') {
      console.warn('[lively.freezer] Skipped async/await transpilation because babel not loaded.');
      return source;
    }
    let options = {
      sourceMap: undefined, // 'inline' || true || false
      inputSourceMap: undefined,
      babelrc: false,
      presets: [["es2015", {"modules": false}]],
      plugins: ['transform-exponentiation-operator', 'transform-async-to-generator', 
                "syntax-object-rest-spread", "transform-object-rest-spread"],
      code: true,
      ast: false
    };
    var sourceForBabel = source.startsWith('function (') ? `(${source})` : source,
        transpiled = babel.transform(sourceForBabel, options).code;
    transpiled = transpiled.replace(/\}\)\.call\(undefined\);$/, "}).call(this)");
    if (transpiled.startsWith('(function') && transpiled.endsWith(');')) transpiled = transpiled.slice(1, -2);
    return transpiled;
}

export class Module {

  static registerExt(ext, klass) {
    if (!this.extensions) this.extensions = {};
    this.extensions[ext] = klass;
  }

  static create(opts = {}) {
    var {name, id} = opts, _;
    if (!name && id) {
      [_, name] = id.match(/\/([^\/]+$)/) || [, id];
    }

    if (!name) throw new Error("Module needs name!");

    let [_2, ext] = name.match(/\.([^\.]+)$/) || [],
        klass = (this.extensions && this.extensions[ext]) || JSModule;
    if (!klass) throw new Error(`No class found for ${name}`);

    return new klass(opts);
  }

  constructor(opts = {}) {
    var {name, id, package: p} = opts;
    this._name = name;
    this._id = id;
    this._package = p;
    this._evalId = 1;
    this._format = module(this.qualifiedName).format();
    this.reset();
  }

  reset() {
    this._content = null;
    this.dependencies = new Map();
    this.dependents = new Set();
    this.exports = [];
  }

  addDependency(otherModule, importSpec) {
    if (![...this.dependencies.keys()].find(m => m.id == otherModule.id)) {
       this.dependencies.set(otherModule, importSpec);
       otherModule.addDependent(this);
    }
    return otherModule;
  }

  addDependent(otherModule) { this.dependents.add(otherModule); }

  get name() { return this._name; }

  get package() { return this._package; }

  get format() { return this._format; }

  get id() {
    if (this._id) return this._id;
    if (this.package) return join(this.package.id, this.name);
    throw new Error(`id: Needs package or _id! (${this.name})`);
  }

  get qualifiedName() {
    if (this.package) return 'local://' + join(this.package.qualifiedName, this.name);
    if (this.id) return this.id.startsWith('http') ? this.id : ('local://' + this.id);
    throw new Error(`qualifiedName: Needs package or id!`);
  }

  nameAsUniqueJSIdentifier(boundNames = []) {
    return findUniqJsName(this.qualifiedName, boundNames);
  }

  get isExcluded() {
    return !this.package || this.package.isExcluded;
  }

  get resource() {
    let {package: p} = this;
    return p ? p.resource.join(this.name) : resource(this.id);
  }

  async source() {
    return await module(this.resource.url).source();
  }

  parse() { throw new Error("Implement me!"); }
  async resolveImports(bundle) { await this.parse(); return this; }
  transformToRegisterFormat(opts) {  throw new Error("Implement me!"); }
  
  getDependenciesLocatedIn(pkg) {
    return [...this.dependencies.keys()].filter(m => m.package == pkg);
  }

  getDependentsOutsideOfPackage(pkg) {
    return [...this.dependents].filter(m => !!m.package && m.package != pkg && !m.package.standaloneGlobal)
  }
}

export class StandaloneModule extends Module {
  
  async parse() { 
    if (this._source) return;
    this._source = await this.source();
    // add deps from module metadata if present
    let { deps } = module(this.id).metadata() || {}; // get other global modules this module may be dependent on
    if (deps) {
      for (let importPath of deps) {
         let { id } = module(
           System.decanonicalize(
             join(this.id, '../' + importPath)
           ).replace(System.baseURL, "")
         ); 
         // standalone modules can only depend on other standalone modules
         this.addDependency(new StandaloneModule({ id }), {
           isPackageImport: true, imports: []
         });
      }
    }
  }

  wrapStandalone(source, runtimeGlobal) {
    const pkg = this.package;
    if (this.format === 'global') {
      return `${runtimeGlobal}.globalModules["${this.qualifiedName}"] = (function() {
         var fetchGlobals = ${runtimeGlobal}.prepareGlobal("${this.qualifiedName}");
         ${source};
         return { exports: fetchGlobals() };
      })()\n`;
    }
    return `(function(module /* exports, require */) {
             // optional parameters
             var exports = arguments.length > 0 && arguments[1] !== undefined ? arguments[1] : {};
             var require = arguments.length > 1 && arguments[2] !== undefined ? arguments[2] : function () {};

             // try to simulate node.js context
             var exec = function(exports, require) { ${source} };
             exec(exports, require);
             if (lively.lang.obj.isEmpty(module.exports)) module.exports = exports;
             if (lively.lang.obj.isEmpty(module.exports)) {
                exec(); // try to run as global
             }
           })(${runtimeGlobal}.globalModules["${this.qualifiedName}"] = {exports: {}})`;
  }

  get qualifiedName() {
    if (this.id) {
      let id = this.id.replace(System.baseURL, "");
      return id.startsWith('http') ? id : ('local://' + id);
    }
    throw new Error(`qualifiedName: Needs package or id!`);
  }
  
  async transformToRegisterFormat(opts) {
    await this.parse();
    let {_source: source} = this, exports = [],
        {runtimeGlobal} = opts;

    if (!runtimeGlobal) throw new Error("No runtimeGlobal name defined!");

    return `\n${await this.wrapStandalone(source, runtimeGlobal)}\n`
         + `${runtimeGlobal}.register("${this.qualifiedName}", [], function(_export, _context) {\n`
         + `  "use strict";\n`
         + `  return {\n`
         + `    setters: [],\n`
         + `    execute: function() {\n`
         + `      var exports = ${runtimeGlobal}.globalModules["${this.qualifiedName}"].exports;\n`
         + `      if (typeof exports == 'function') {\n`
         + `         _export("default", exports);\n`
         + `      } else {\n`
         + `        _export(exports);\n`
         + `        if (!exports['default']) _export('default', exports);\n`
         + `      }\n`
         + `    }\n`
         + `  }\n`
         + `});`
  }

  get isExcluded() {
    return false
  }
    
}

class EmptyModule extends Module {

  parse() { }
  
  transformToRegisterFormat(opts) { }

  get isEmpty() { return true }

  get qualifiedName() {
    return '@empty';
  }
  
  get id() {
    return '@empty';
  }

  get isExcluded() {
    return false
  }
  
  async source() {
     return "()"
  }
}

export class JSONModule extends Module {

  async parse() {
    try {
      let source = await this.source();
      this.json = JSON.parse(source);
    } catch (err) { throw new Error(`Error reading JSON ${this.qualifiedName}: ${err.stack}`); }
  }

  transformToRegisterFormat(opts = {}) {
    let {json} = this, exports = [];
    if (typeof json === "object" && !Array.isArray(json))
      exports.push(...Object.keys(json));

    let {runtimeGlobal} = opts;

    if (!runtimeGlobal) throw new Error("No runtimeGlobal name defined!");

    return `${runtimeGlobal}.register("${this.qualifiedName}", [], function(_export, _context) {\n`
         + `  "use strict";\n`
         + `  return {\n`
         + `    setters: [],\n`
         + `    execute: function() {\n`
         + string.indent(`var json = ${JSON.stringify(json)}`, "  ", 3) + ";\n"
         + `      _export("default", json);\n`
         + (exports.length ? `      ${exports.map(ea => `_export("${ea}", json["${ea}"]);`).join("\n      ")}` : "")
         + `    }\n`
         + `  }\n`
         + `});`
  }

}


export class JSModule extends Module {

  async parse() {
    let parsed, scope, rawImports,
        exports = [], rawExports, source,
        dependencies = {};

    try {
      source = await this.source();
      parsed = parse(source, {addAstIndex: true});
      scope = query.scopes(parsed);
      rawImports = query.imports(scope);
      rawExports = query.exports(scope);
    } catch (err) { throw new Error(`Error parsing ${this.name}: ${err.stack}`); }

    for (let i of rawImports) {
      let {fromModule, imported, local, node} = i,
          dep = dependencies[fromModule] || (dependencies[fromModule] = {imports: []});
      dep.imports.push({imported, local, node});
    }

    for (let e of rawExports) {
      let {fromModule, imported, exported, local, node} = e;
      if (fromModule) {
        let dep = dependencies[fromModule] || (dependencies[fromModule] = {imports: []});
        dep.imports.push({imported, exported, node});
      }
      exports.push({exported, local});
    }

    this.rawDependencies = dependencies;
    this.parsed = parsed;
    this.scope = scope;
    this.exports = exports;
    this.rawExports = rawExports;
    this.rawImports = rawImports;

    return this;
  }

  async resolveImports(bundle) {
    // 1. try to resolve the "from" part of local imports
    // 2. find local var names for object capturing imports

    await this.parse();

    let {rawDependencies} = this;
    for (let localName in rawDependencies) {
      let {imports} = rawDependencies[localName],
          {module: otherModule, isPackageImport} = this.resolveImport(localName, bundle, imports);
      this.addDependency(otherModule, {imports, isPackageImport});
    }

    return this;
  }

  resolveImport(localName, bundle, imports) {
    if (isURL(localName)) {
      return {
        module: bundle.findModuleWithId(localName)
             || bundle.addModule(new StandaloneModule({
               name: localName,
               id: localName,
               package: null
             }))
      };
    }

    if (localName.startsWith(".")) {
      if (!this.package) throw new Error("local module needs package!");
      let name = join(parent(this.name), localName);
      return {
        module: bundle.findModuleInPackageWithName(this.package, name)
             || bundle.addModule(bundle.addModule(Module.create({name, package: this.package})))
      };
    }

    let packageName = localName.includes("/") ?
                       localName.slice(0, localName.indexOf("/")) :
                       localName,
        nameInPackage = localName.slice(packageName.length),
        packageSpec = bundle.findPackage(packageName),
        isPackageImport = !nameInPackage;

    if (!packageSpec){
      var id;
      if (this.package) {
        let {_config: c} = this.package;
        if (c && c.systemjs && c.systemjs.map) {
          let remappedName = c.systemjs.map[localName];
          if (remappedName) {
            if (remappedName["~node"] == '@empty')
              return {
                isPackageImport,
                module: bundle.findModuleWithId('@empty') || bundle.addModule((new EmptyModule()))
              }
            if (remappedName.startsWith(".")) {
              id = join(this.package.path, remappedName);
            } else {
              id = System.decanonicalize(remappedName);
            }
            // assume that remappings point to standalone modules
            return {
              isPackageImport,
              module: bundle.findModuleWithId(id)
                   || bundle.addModule(new StandaloneModule({
                     name: localName, 
                     id,
                     package: null}))
            }
          }
        }
      }
      if (!id) id = System.decanonicalize(localName);
      return {
        isPackageImport,
        module: bundle.findModuleWithId(id)
             || bundle.addModule(bundle.addModule(Module.create({name: localName, id, package: null})))
      }
    }
    if (isPackageImport && packageSpec) {
      nameInPackage = packageSpec.main || (packageSpec.systemjs && packageSpec.systemjs.main) || "/index.js"
      nameInPackage = nameInPackage.replace('./', '/');
      if (!string.startsWith(nameInPackage, '/')) nameInPackage = '/' + nameInPackage;
    }
    return {
      isPackageImport,
      module: bundle.findModuleInPackageWithName(packageSpec, nameInPackage)
           || bundle.findModuleWithId(`local://${packageSpec.name}${nameInPackage}`)
           || bundle.addModule(bundle.addModule(Module.create({name: nameInPackage, package: packageSpec})))
    };
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // transform
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  registerTranformsOfImports(clearExcludedModules = false) {
    let topLevelIds = [], setters = [], qualifiedDependencyNames = [], undefinedTopLevelVars = [];

    for (let [depModule, {imports}] of this.dependencies) {
      if (clearExcludedModules && depModule.isExcluded) {
        depModule = new EmptyModule();
      }

      // FIXME what if a toplevel var of `this` has the same name as the generated varName?
      let varName = depModule.nameAsUniqueJSIdentifier([]),
          id = depModule.qualifiedName,
          setterStmts = [];
      
      qualifiedDependencyNames.push(id);

      for (let i of imports) {
        let {node: {type, astIndex}, imported, local, exported} = i;
        
        if (type === "ExportAllDeclaration") { // export * from "foo"
          setterStmts.push(nodes.exprStmt(nodes.funcCall("_export", nodes.id(varName))));
          continue;
        }

        if (exported) { // export { x } from "foo"
          setterStmts.push(nodes.exprStmt(nodes.funcCall("_export", nodes.literal(exported), nodes.member(nodes.id(varName), imported))));
          continue;
        }

        if (local) {
          topLevelIds.push(nodes.id(local));
          if (depModule.isEmpty) undefinedTopLevelVars.push(local);
        }
        if (imported === "*") {
          setterStmts.push(nodes.exprStmt(nodes.assign(local, nodes.id(varName))));
        } else {
          if (imported && local)
            setterStmts.push(nodes.exprStmt(nodes.assign(local, nodes.member(nodes.id(varName), imported))));
        }
      }
      
      setters.push(nodes.funcExpr({}, [nodes.id(varName)], ...setterStmts))
    }

    let topLevelDecl = topLevelIds.length ? {
      type: "VariableDeclaration",
      kind: "var",
      declarations: topLevelIds.map(ea => ({type: "VariableDeclarator", id: ea, init: null}))
    } : null;

    // ensure that setters and dep names are in sync
    return {topLevelDecl, setters, undefinedTopLevelVars,
            qualifiedDependencyNames};
  }

  registerTranformsOfExports() {
    let exported = [];

    for (let node of this.parsed.body) {
      let {type, declaration, specifiers} = node;
      if (!type.match(/^Export.*Declaration$/)) continue;

      let exportTransform = {node, replacementFunc: () => [], ids: []};
      exported.push(exportTransform);

      if (type === "ExportNamedDeclaration" && declaration) {

        switch (declaration.type) {

          case 'VariableDeclaration':
            exportTransform.replacementFunc = (node, source, wasChanged) => {
              source = source.replace(/^(\s*)export\s+/, "");
              let ids = query.helpers.declIds(node.declaration.declarations.map(ea => ea.id)),
                  exports = ids.map(id => exportCall(id.name, id)).join("\n")
              return source + "\n" + exports;
            }
            // for (let id of query.helpers.declIds(declaration.declarations.map(ea => ea.id)))
            //   exportTransform.ids.push({local: id, exported: id});
            break;

          case 'ClassDeclaration': case 'FunctionDeclaration':
            exportTransform.replacementFunc = (node, source, wasChanged) =>
                source.replace(/^(\s*)export\s+/, ``) + "\n"
              + exportCall(node.declaration.id.name, node.declaration.id);
            break;
        }
        continue;
      }

      if (type === "ExportNamedDeclaration" && specifiers) {
        if (node.source) continue; // not for re-exports, those are handled in setter
        for (let {local, exported} of specifiers)
          exportTransform.ids.push({local, exported});
        continue;
      }

      if (type === "ExportDefaultDeclaration" && declaration) {
        switch (declaration.type) {

          case 'Identifier':
            exportTransform.replacementFunc = (node, source, wasChanged) =>
              source.replace(/^export\s+default\s+/, "") + "\n" + exportCall("default", node.declaration);
            break;

          case 'ClassDeclaration': case 'FunctionDeclaration':
            exportTransform.replacementFunc = (node, source, wasChanged) =>
              source.replace(/^export\s+default\s+/, "") + exportCall("default", node.declaration.id);
            break;

          default:
            throw new Error(`Strange default export declaration: ${declaration.type}`);
        }

        continue;
      }

      if (type === "ExportAllDeclaration") {
        continue;
      }
    }

    return exported;
  }

  async transformToLivelyModulesFormat() {
    // mock the module
    if (this._cachedLivelyModule) return this._cachedLivelyModule;
    let mod = module(this.qualifiedName),
        localId = this.id == '@empty' ? this.id : (this.qualifiedName);
    mod.recorderName = "__lvVarRecorder";
    mod.embedOriginalCode = false;
    let { options, source } = prepareCodeForCustomCompile(System, await this.source(), localId, mod);
    mod.embedOriginalCode = true;
    let Transpiler = System.get('lively.transpiler').default;
    source = new Transpiler(System, localId, {}).transpileModule(source, {})
    source = prepareTranslatedCodeForSetterCapture(System, source, localId, mod, options);
    return this._cachedLivelyModule = source.split("defVar_" + this.id).join("defVar_" + localId);
  }

  async transformToRegisterFormat(opts = {}) {
    let {runtimeGlobal = "System", clearExcludedModules = false, livelyTranspilation = false} = opts,
        {topLevelDecl, setters, qualifiedDependencyNames, undefinedTopLevelVars} = this.registerTranformsOfImports(clearExcludedModules),
        undefinedVarArray = `[${undefinedTopLevelVars.map(v => `"${v}"`).join(', ')}]`,
        undefinedDeclaration = `lively.FreezerRuntime.registry["${this.qualifiedName}"].emptyImports = new Set(${undefinedVarArray});`,
        topLevelVarNames = topLevelDecl && topLevelDecl.declarations.map(ea => ea.id.name),
        transpiledSource;
    if (livelyTranspilation) {
      let s = await this.transformToLivelyModulesFormat();
      transpiledSource = s.slice(s.indexOf('function (_export, _context)'), s.length - 2)
                          .replace(`"use strict";`,  `"use strict";\n  ${undefinedDeclaration}`);
    } else {
      let exportTransformData = this.registerTranformsOfExports(),
          additionalExports = [],
          tfmOpts = {
            classHolder: {type: "Identifier", name: "__rec"},
            currentModuleAccessor: {type: "Identifier", name: "__mod"},
            functionNode: {type: "Identifier", name: "System.initializeClass"}},
          replaced = transform.replaceNodes([
          // remove import decls completely
          ...this.parsed.body.filter(ea => ea.type === "ImportDeclaration")
                              .map(target => ({target, replacementFunc: () => []})),
          // remove exports
          ...exportTransformData.map(({node: target, replacementFunc, ids}) => {
            additionalExports.push(...ids.map(ea => exportCall(ea.exported.name, ea.local)))
            return {target, replacementFunc}
          })
        ], await this.source());
        replaced = es5Transpilation(stringify(objectSpreadTransform(rewriteToCaptureTopLevelVariables(parse(replaced.source), {
          type: "Identifier", name: "__rec"}, {
          classToFunction: tfmOpts,
          es6ExportFuncId: '_export',
          ignoreUndeclaredExcept: []
        }))));
        transpiledSource = `function(_export, _context) {\n`
         + `  "use strict";\n`
         + (topLevelDecl ? `  ${stringify(topLevelDecl)}\n` : "")
         + `${undefinedDeclaration}\n` 
         + `  return {\n`
         + `    setters: [\n`
         + `${string.indent(setters.map(stringify).join(",\n"), "  ", 3)}\n`
         + `    ],\n`
         + `    execute: function() {\n`
         + `var __mod = System.get("${this.qualifiedName}");\n`
         + `var __rec = __mod.recorder = {};\n`
         + (topLevelVarNames || []).map(id => `__rec.${id} = ${id};`).join('\n')
         + `${string.indent(replaced.trim(), "  ", 3)}\n`
         + (additionalExports.length ? `${string.indent(additionalExports.join("\n"), "  ", 3)}\n` : "")
         + `    }\n`
         + `  }\n`
         + `}` 
    }

    return `${runtimeGlobal}.register("${this.qualifiedName}", `
         + `[${qualifiedDependencyNames.map(ea => `"${ea}"`).join(", ")}], `
         +  transpiledSource
         + `);`
  }

}


Module.registerExt("js", JSModule);
Module.registerExt("json", JSONModule);