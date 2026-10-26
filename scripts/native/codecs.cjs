const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const sharp = pathToFileURL(
  require.resolve(join(process.env.OPENFRAME_CODECS, "sharp-native")),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith("@img/sharp-") &&
      specifier.endsWith("/sharp.node")
    ) {
      throw new Error(
        "Native runtime requires the source-built Sharp addon; bundled fallback is disabled",
      );
    }
    return specifier === "sharp"
      ? { url: sharp, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
