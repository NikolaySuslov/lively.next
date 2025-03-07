var config = {
  server: {
    freezer: { publicDirs: [] },
    port: 9011,
    hostname: "0.0.0.0",
    plugins: [
      "lively.server/plugins/cors.js",
      "lively.server/plugins/dav.js",
      "lively.server/plugins/discussion.js",
      "lively.server/plugins/eval.js",
      "lively.server/plugins/l2l.js",
      "lively.server/plugins/lib-lookup.js",
      "lively.server/plugins/proxy.js",
      "lively.server/plugins/remote-shell.js",
      "lively.server/plugins/socketio.js",
      "lively.server/plugins/world-loading.js",
      "lively.server/plugins/file-upload.js",
      "lively.server/plugins/objectdb.js",
      "lively.server/plugins/pdf-printer.js",
      "lively.server/plugins/subserver.js",
      "lively.headless/subserver.js",
      "lively.freezer/server.js"
    ]
  }
}

export default config;
