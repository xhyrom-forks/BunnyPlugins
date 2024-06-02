import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import swc from "@swc/core";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { extname, join } from "path";
import { argv } from "process";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import tsConfigPaths from "rollup-plugin-tsconfig-paths";

const markdownHeader = `<!--
  * This file was autogenerated
  * If you want to change anything, do so in the build.mjs script
  * https://github.com/nexpid/BunnyPlugins/edit/main/scripts/build.mjs
-->`;

const extensions = [".js", ".jsx", ".mjs", ".ts", ".tsx", ".cts", ".mts"];

const hasFlag = (short, long) =>
  argv.includes(`-${short}`) || argv.includes(`--${long}`);

const onlyPlugins = argv.slice(2).filter((x) => !x.startsWith("--"));
const isDev = hasFlag("d", "dev");

if (!existsSync("./dist")) await mkdir("./dist");
await writeFile(
  "./dist/404.md",
  `---
title: 404
description: You probably made a typo or something
---

${markdownHeader}

<div align="center">
  <h1>Well, that's awkward.</h1>
  <h3>You probably misclicked or something, click <a href="/"><b>here</b></a> to go back.</h3>
</div>\n`,
);

for (const plug of await readdir("./plugins")) {
  if (onlyPlugins.length && !onlyPlugins.includes(plug)) continue;

  const manifest = JSON.parse(
    await readFile(`./plugins/${plug}/manifest.json`),
  );
  const title = `${manifest.name} (by ${manifest.authors
    .map((x) => x.name)
    .join(", ")})`;

  if (!existsSync(`./dist/${plug}`)) await mkdir(`./dist/${plug}`);
  await writeFile(
    `./dist/${plug}/index.md`,
    `---
title: ${title}
description: ${manifest.description}
---

${markdownHeader}

<div align="center">
    <h1>${title}</h1>
    <h3>${manifest.description}</h3>
</div>

> **Note**
> This is a landing page for the plugin **${manifest.name}**. The proper way to install this plugin is going to Bunny's Plugins page and adding it there.\n`,
  );

  try {
    const langPlug = plug.replace(/-/g, "_");

    const langPaths = {
      values: join("lang/values", `${langPlug}.json`),
      default: join("lang/values/base", `${langPlug}.json`),
    };

    let langValues;
    if (isDev && existsSync(langPaths.values))
      langValues = JSON.parse(await readFile(langPaths.values, "utf8"));

    let langDefault;
    if (!isDev && existsSync(langPaths.default))
      langDefault = JSON.parse(await readFile(langPaths.default, "utf8"));

    const bundle = await rollup({
      input: `./plugins/${plug}/${manifest.main}`,
      onwarn: () => {},
      plugins: [
        tsConfigPaths(),
        nodeResolve(),
        commonjs(),
        {
          name: "swc",
          async transform(code, id) {
            const ext = extname(id);
            if (!extensions.includes(ext)) return null;

            const ts = ext.includes("ts");
            const tsx = ts ? ext.endsWith("x") : undefined;
            const jsx = !ts ? ext.endsWith("x") : undefined;

            const result = await swc.transform(code, {
              filename: id,
              jsc: {
                externalHelpers: false,
                parser: {
                  syntax: ts ? "typescript" : "ecmascript",
                  tsx,
                  jsx,
                },
              },
              env: {
                targets: "defaults",
                include: [
                  "transform-classes",
                  "transform-arrow-functions",
                  "transform-class-properties",
                ],
              },
            });
            return result.code;
          },
        },
        {
          name: "file-parser",
          async transform(code, id) {
            const parsers = {
              text: ["html", "css", "svg"],
              raw: ["json"],
              uri: ["png"],
            };
            const extToMime = {
              png: "image/png",
            };

            const ext = extname(id).slice(1);
            const mode = Object.entries(parsers).find(([_, v]) =>
              v.includes(ext),
            )?.[0];
            if (!mode) return null;

            let thing;
            if (mode === "text") thing = JSON.stringify(code);
            else if (mode === "raw") thing = code;
            else if (mode === "uri")
              thing = JSON.stringify(
                `data:${extToMime[ext] ?? ""};base64,${(await readFile(id)).toString("base64")}`,
              );

            if (thing) return { code: `export default ${thing}` };
          },
        },
        esbuild({
          minifySyntax: !isDev,
          minifyWhitespace: !isDev,
          define: {
            IS_DEV: String(isDev),
            DEFAULT_LANG: langDefault
              ? JSON.stringify(langDefault)
              : "undefined",
            DEV_LANG: langValues ? JSON.stringify(langValues) : "undefined",
          },
        }),
      ],
    });

    const outPath = `./dist/${plug}/index.js`;

    await bundle.write({
      file: outPath,
      globals(id) {
        if (id.startsWith("@vendetta"))
          return id.substring(1).replace(/\//g, ".");
        const map = {
          react: "window.React",
        };

        return map[id] || null;
      },
      format: "iife",
      compact: true,
      exports: "named",
    });
    await bundle.close();

    const toHash = await readFile(outPath);
    manifest.hash = createHash("sha256").update(toHash).digest("hex");
    manifest.main = "index.js";
    await writeFile(`./dist/${plug}/manifest.json`, JSON.stringify(manifest));

    console.log(`Successfully built ${manifest.name}!`);
  } catch (e) {
    console.error("Failed to build plugin...", e);
    process.exit(1);
  }
}
