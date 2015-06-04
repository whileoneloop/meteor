var archinfo = require('./archinfo.js');
var buildmessage = require('./buildmessage.js');
var buildPluginModule = require('./build-plugin.js');
var colonConverter = require('./colon-converter.js');
var files = require('./files.js');
var compiler = require('./compiler.js');
var linker = require('./linker.js');
var util = require('util');
var _ = require('underscore');

exports.CompilerPlugin = function (pluginDefinition, userPlugin) {
  var self = this;
  // The actual object returned from the user-supplied factory.
  self.userPlugin = userPlugin;
  self.pluginDefinition = pluginDefinition;
};
_.extend(exports.CompilerPlugin.prototype, {
  // XXX BBP full docs
  run: function (resourceSlots) {
    var self = this;

    var inputFiles = _.map(resourceSlots, function (resourceSlot) {
      return new InputFile(resourceSlot);
    });

    var markedMethod = buildmessage.markBoundary(
      self.userPlugin.processFilesForTarget.bind(self.userPlugin));
    try {
      markedMethod(inputFiles);
    } catch (e) {
      buildmessage.exception(e);
    }
  }
});


exports.CompilerPluginProcessor = function (options) {
  var self = this;
  self.unibuilds = options.unibuilds;
  self.arch = options.arch;
  self.isopackCache = options.isopackCache;
  // id -> CompilerPlugin
  self.compilerPlugins = null;
  // id -> [ResourceSlot]
  self.resourceSlotsByPluginId = {};
};
_.extend(exports.CompilerPluginProcessor.prototype, {
  // XXX BBP don't re-instantiate buildPlugins on every rebuild
  _loadPluginsAndInstantiatePlugins: function () {
    var self = this;
    self.compilerPlugins = {};
    self.resourceSlotsByPluginId = {};
    _.each(self.unibuilds, function (unibuild) {
      var isopack = unibuild.pkg;
      isopack.ensurePluginsInitialized();
      _.each(
        isopack.sourceProcessors.compiler,
        function (buildPluginDefinition, id) {
          if (_.has(self.compilerPlugins, id)) {
            throw Error("duplicate compilerPlugin plugin ID! " + id);
          }
          self.compilerPlugins[id] = buildPluginDefinition.instantiatePlugin();
          self.resourceSlotsByPluginId[id] = [];
        }
      );
    });
  },

  runCompilerPlugins: function () {
    var self = this;
    buildmessage.assertInJob();

    self._loadPluginsAndInstantiatePlugins();

    var sourceBatches = _.map(self.unibuilds, function (unibuild) {
      return new PackageSourceBatch(unibuild, self);
    });

    // Find out which files go with which CompilerPlugins.
    _.each(sourceBatches, function (sourceBatch) {
      _.each(sourceBatch.resourceSlots, function (resourceSlot) {
        var buildPluginDefinition = resourceSlot.buildPluginDefinition;
        // Skip non-sources.
        if (! buildPluginDefinition)
          return;

        if (! _.has(self.compilerPlugins, buildPluginDefinition.id)) {
          throw Error("uninstantiated compiler plugin " +
                      buildPluginDefinition.id);
        }
        self.resourceSlotsByPluginId[buildPluginDefinition.id].push(
          resourceSlot);
      });
    });

    // Now actually run the handlers.
    _.each(self.compilerPlugins, function (compilerPlugin, id) {
      var resourceSlots = self.resourceSlotsByPluginId[id];
      if (! resourceSlots) {
        throw Error("compiler plugin without slots? " + id);
      }
      // Don't run CompilerPlugins with no files.
      if (! resourceSlots.length)
        return;

      buildmessage.enterJob({
        title: "processing files with " +
          compilerPlugin.pluginDefinition.isopack.name
      }, function () {
        compilerPlugin.run(resourceSlots);
      });}
    );

    return sourceBatches;
  }
});

var InputFile = function (resourceSlot) {
  var self = this;
  // We use underscored attributes here because this is user-visible code and we
  // don't want users to be accessing anything that we don't document.
  self._resourceSlot = resourceSlot;
};
util.inherits(InputFile, buildPluginModule.InputFile);
_.extend(InputFile.prototype, {
  getContentsAsBuffer: function () {
    var self = this;
    return self._resourceSlot.inputResource.data;
  },
  getPackageName: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.pkg.name;
  },
  getPathInPackage: function () {
    var self = this;
    return self._resourceSlot.inputResource.path;
  },
  getFileOptions: function () {
    var self = this;
    // XXX fileOptions only exists on some resources (of type "source"). The JS
    // resources might not have this property.
    return self._resourceSlot.inputResource.fileOptions;
  },

  /**
   * @summary Returns a list of symbols declared as exports in this target. The
   * result of `api.export('symbol')` calls in target's control file such as
   * package.js.
   * @memberof InputFile
   * @returns {String[]}
   */
  getDeclaredExports: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.declaredExports;
  },

  /**
   * @summary Returns a relative path that can be used to form error messages or
   * other display properties. Can be used as an input to a source map.
   * @memberof InputFile
   * @returns {String}
   */
  getDisplayPath: function () {
    var self = this;
    return self._resourceSlot.packageSourceBatch.unibuild.pkg._getServePath(self.getPathInPackage());
  },

  /**
   * @summary Web targets only. Add a stylesheet to the document. Not available
   * for linter build plugins.
   * @param {Object} options
   * @param {String} options.path The requested path for the added CSS, may not
   * be satisfied if there are path conflicts.
   * @param {String} options.data The content of the stylesheet that should be
   * added.
   * @param {String} options.sourceMap A stringified JSON sourcemap, in case the
   * stylesheet was generated from a different file.
   * @memberOf InputFile
   * @instance
   */
  addStylesheet: function (options) {
    var self = this;
    // XXX BBP validate input!!
    self._resourceSlot.addStylesheet(options);
  },
  /**
   * @summary Add JavaScript code. The code added will only see the
   * namespaces imported by this package as runtime dependencies using
   * ['api.use'](#PackageAPI-use). If the file being compiled was added
   * with the bare flag, the resulting JavaScript won't be wrapped in a
   * closure.
   * @param {Object} options
   * @param {String} options.path The path at which the JavaScript file
   * should be inserted, may not be honored in case of path conflicts.
   * @param {String} options.data The code to be added.
   * @param {String} options.sourceMap A stringified JSON sourcemap, in case the
   * JavaScript file was generated from a different file.
   * @memberOf InputFile
   * @instance
   */
  addJavaScript: function (options) {
    var self = this;
    self._resourceSlot.addJavaScript(options);
  },
  /**
   * @summary Add a file to serve as-is to the browser or to include on
   * the browser, depending on the target. On the web, it will be served
   * at the exact path requested. For server targets, it can be retrieved
   * using `Assets.getText` or `Assets.getBinary`.
   * @param {Object} options
   * @param {String} options.path The path at which to serve the asset.
   * @param {Buffer|String} options.data The data that should be placed in the
   * file.
   * @param {String} [options.hash] Optionally, supply a hash for the output
   * file.
   * @memberOf InputFile
   * @instance
   */
  addAsset: function (options) {
    var self = this;
    self._resourceSlot.addAsset(options);
  }
});

// XXX BBP doc
var ResourceSlot = function (unibuildResourceInfo,
                             buildPluginDefinition,
                             packageSourceBatch) {
  var self = this;
  self.inputResource = unibuildResourceInfo;  // XXX BBP prototype?
  // Everything but JS.
  self.outputResources = [];
  // JS, which gets linked together at the end.
  self.jsOutputResources = [];
  self.buildPluginDefinition = buildPluginDefinition;
  self.packageSourceBatch = packageSourceBatch;

  if (self.inputResource.type === "source" &&
      self.inputResource.extension === "js") {
    // #HardcodeJs
    if (buildPluginDefinition) {
      throw Error("buildPluginDefinition found for js source? " +
                  JSON.stringify(unibuildResourceInfo));
    }
    self.addJavaScript({
      // XXX it's a shame to keep converting between Buffer and string, but
      // files.convertToStandardLineEndings only works on strings for now
      data: self.inputResource.data.toString('utf8'),
      path: self.inputResource.path,
      hash: self.inputResource.hash,
      bare: self.inputResource.fileOptions &&
        (self.inputResource.fileOptions.bare ||
         // XXX eventually get rid of backward-compatibility "raw" name
         // XXX COMPAT WITH 0.6.4
         self.inputResource.fileOptions.raw)
    });
  } else if (self.inputResource.type === "source") {
    if (! buildPluginDefinition) {
      throw Error("no buildPluginDefinition plugin for source? " +
                  JSON.stringify(unibuildResourceInfo));
    }
  } else {
    if (buildPluginDefinition) {
      throw Error("buildPluginDefinition plugin for non-source? " +
                  JSON.stringify(unibuildResourceInfo));
    }
    // Any resource that isn't handled by compiler plugins just gets passed
    // through.
    if (self.inputResource.type === "js") {
      self.jsOutputResources.push(self.inputResource);
    } else {
      self.outputResources.push(self.inputResource);
    }
  }
};
_.extend(ResourceSlot.prototype, {
  // XXX BBP check args
  addStylesheet: function (options) {
    var self = this;
    if (! self.buildPluginDefinition)
      throw Error("addStylesheet on non-source ResourceSlot?");

    // XXX BBP prototype?
    self.outputResources.push({
      type: "css",
      refreshable: true,
      data: new Buffer(files.convertToStandardLineEndings(options.data), 'utf8'),
      servePath: self.packageSourceBatch.unibuild.pkg._getServePath(
        options.path),
      // XXX BBP convertSourceMapPaths ???
      sourceMap: options.sourceMap
    });
  },
  addJavaScript: function (options) {
    var self = this;
    // #HardcodeJs this gets called by constructor in the "js" case
    if (! self.buildPluginDefinition && self.inputResource.extension !== "js")
      throw Error("addJavaScript on non-source ResourceSlot?");

    self.jsOutputResources.push({
      type: "js",
      data: new Buffer(
        files.convertToStandardLineEndings(options.data), 'utf8'),
      servePath: self.packageSourceBatch.unibuild.pkg._getServePath(
        options.path),
      // XXX BBP this hash is from before the line ending conversion!  is that
      // right?
      // XXX BBP should we trust this if it comes from a user instead of from
      // our own call in the ResourceSlot constructor?
      hash: options.hash,
      sourceMap: options.sourceMap,
      bare: options.bare
    });
  },
  addAsset: function (options) {
    var self = this;
    if (! self.buildPluginDefinition)
      throw Error("addAsset on non-source ResourceSlot?");

    if (! (options.data instanceof Buffer)) {
      if (_.isString(options.data)) {
        options.data = new Buffer(options.data);
      } else {
        throw new Error("'data' option to addAsset must be a Buffer or String.");
      }
    }

    // XXX BBP this is partially duplicated in isopack.js
    var outputPath = files.convertToStandardPath(options.path, true);
    var unibuild = self.packageSourceBatch.unibuild;
    var serveRoot;
    if (unibuild.pkg.name) {
      serveRoot = files.pathJoin('/packages/', unibuild.pkg.name);
    } else {
      serveRoot = '/';
    }
    if (! unibuild.name) {
      // XXX hack for app's special folders
      outputPath = outputPath.replace(/^(private|public)\//, '');
    }
    throw Error("assets are apparently broken")  // XXX BBP
    resources.push({
      type: 'asset',
      data: options.data,
      path: outputPath,
      servePath: colonConverter.convert(
        files.pathJoin(inputSourceArch.pkg.serveRoot, relPath)),
      hash: options.hash
    });
  }
});

// XXX BBP ???
var PackageSourceBatch = function (unibuild, processor) {
  var self = this;
  self.unibuild = unibuild;
  self.processor = processor;
  var buildPluginDefinitionsByExtension =
        self._getBuildPluginDefinitionsByExtension();
  self.resourceSlots = _.map(unibuild.resources, function (resource) {
    var buildPluginDefinition = null;
    if (resource.type === "source") {
      var extension = resource.extension;
      if (extension === 'js') {
        // #HardcodeJs In this case, we just leave buildPlugin null; it is
        // specially handled by ResourceSlot too.
      } else if (_.has(buildPluginDefinitionsByExtension, extension)) {
        buildPluginDefinition = buildPluginDefinitionsByExtension[extension];
      } else {
        // XXX BBP better error handling
        throw Error("no plugin found for " + JSON.stringify(resource));
      }
    }
    return new ResourceSlot(resource, buildPluginDefinition, self);
  });
};
_.extend(PackageSourceBatch.prototype, {
  _getBuildPluginDefinitionsByExtension: function () {
    var self = this;
    var isopack = self.unibuild.pkg;
    // Packages always get plugins from themselves.
    var activePluginPackages = [isopack];

    // We don't use plugins from weak dependencies, because the ability to build
    // a certain type of file shouldn't depend on whether or not some unrelated
    // package in the target has a dependency. And we skip unordered
    // dependencies, because it's not going to work to have circular build-time
    // dependencies.
    //
    // eachUsedUnibuild takes care of pulling in implied dependencies for us
    // (eg, templating from standard-app-packages).
    //
    // We pass archinfo.host here, not self.arch, because it may be more
    // specific, and because plugins always have to run on the host
    // architecture.
    compiler.eachUsedUnibuild({
      dependencies: self.unibuild.uses,
      arch: archinfo.host(),
      isopackCache: self.processor.isopackCache,
      skipUnordered: true
    }, function (otherUnibuild) {
      if (! _.isEmpty(otherUnibuild.pkg.plugins)) {
        activePluginPackages.push(otherUnibuild.pkg);
      }
    });

    activePluginPackages = _.uniq(activePluginPackages);

    var buildPluginDefinitionsByExtension = {};
    _.each(activePluginPackages, function (otherPkg) {
      // self.type is "compiler" or "linter" or similar
      _.each(
        otherPkg.sourceProcessors.compiler,
        function (buildPluginDefinition, id) {
          if (! buildPluginDefinition.relevantForArch(self.processor.arch)) {
            return;
          }

          _.each(buildPluginDefinition.extensions, function (ext) {
            if (_.has(buildPluginDefinitionsByExtension, ext)) {
              // XXX BBP use buildmessage
              throw Error("duplicate extension " + JSON.stringify({
                package: isopack.name,
                ext: ext
              }));
            }
            buildPluginDefinitionsByExtension[ext] = buildPluginDefinition;
          });
        }
      );
    });

    return buildPluginDefinitionsByExtension;
  },

  // Called by bundler's Target._emitResources.  It returns the actual resources
  // that end up in the program for this package.  By this point, it knows what
  // its dependencies are and what their exports are, so it can set up
  // linker-style imports and exports.
  getResources: function () {
    var self = this;
    buildmessage.assertInJob();

    var flatten = function (arrays) {
      return Array.prototype.concat.apply([], arrays);
    };
    var resources = flatten(_.pluck(self.resourceSlots, 'outputResources'));
    var jsResources = flatten(_.pluck(self.resourceSlots, 'jsOutputResources'));
    Array.prototype.push.apply(resources, self._linkJS(jsResources));
    return resources;
  },

  _linkJS: function (jsResources) {
    var self = this;
    buildmessage.assertInJob();

    var isopackCache = self.processor.isopackCache;
    var bundleArch = self.processor.arch;

    if (! archinfo.matches(bundleArch, self.unibuild.arch))
      throw new Error(
        "unibuild of arch '" + self.unibuild.arch + "' does not support '" +
          bundleArch + "'?");

    // Compute imports by merging the exports of all of the packages we
    // use. Note that in the case of conflicting symbols, later packages get
    // precedence.
    //
    // We don't get imports from unordered dependencies (since they may not be
    // defined yet) or from weak/debugOnly dependencies (because the meaning of
    // a name shouldn't be affected by the non-local decision of whether or not
    // an unrelated package in the target depends on something).
    var imports = {}; // map from symbol to supplying package name

    var addImportsForUnibuild = function (depUnibuild) {
      _.each(depUnibuild.declaredExports, function (symbol) {
        // Slightly hacky implementation of test-only exports.
        if (! symbol.testOnly || self.unibuild.pkg.isTest) {
          imports[symbol.name] = depUnibuild.pkg.name;
        }
      });
    };
    compiler.eachUsedUnibuild({
      dependencies: self.unibuild.uses,
      arch: bundleArch,
      isopackCache: isopackCache,
      skipUnordered: true,
      skipDebugOnly: true
    }, addImportsForUnibuild);

    // Run the linker.
    var isApp = ! self.unibuild.pkg.name;
    var linkedFiles = linker.fullLink({
      inputFiles: jsResources,
      useGlobalNamespace: isApp,
      // I was confused about this, so I am leaving a comment -- the
      // combinedServePath is either [pkgname].js or [pluginName]:plugin.js.
      // XXX: If we change this, we can get rid of source arch names!
      combinedServePath: isApp ? null :
        "/packages/" + colonConverter.convert(
          self.unibuild.pkg.name +
            (self.unibuild.kind === "main" ? "" : (":" + self.unibuild.kind)) +
            ".js"),
      name: self.unibuild.pkg.name || null,
      declaredExports: _.pluck(self.unibuild.declaredExports, 'name'),
      imports: imports,
      // XXX report an error if there is a package called global-imports
      importStubServePath: isApp && '/packages/global-imports.js',
      includeSourceMapInstructions: archinfo.matches(self.unibuild.arch, "web")
    });

    // Add each output as a resource
    return _.map(linkedFiles, function (file) {
      return {
        type: "js",
        data: new Buffer(file.source, 'utf8'), // XXX encoding
        servePath: file.servePath,
        sourceMap: file.sourceMap
        // XXX BBP hash?
      };
    });
  }
});

