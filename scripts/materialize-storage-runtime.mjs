import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

/** Preserve each installed dependency version when pnpm links become real folders. */
export function materializeRuntimePackages(sourceRoot, artifactRoot, names) {
  const installedRoot = fs.realpathSync(path.join(sourceRoot, "node_modules"));
  const outputRoot = fs.realpathSync(artifactRoot);
  if (inside(installedRoot, outputRoot) || inside(outputRoot, installedRoot)) throw new Error("Storage runtime source/output overlap");
  const packages = [];

  function resolvePackage(name, from) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new Error("Invalid runtime dependency name");
    for (let current = from; ; current = path.dirname(current)) {
      const candidate = path.join(current, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        const resolved = fs.realpathSync(candidate);
        if (!inside(installedRoot, resolved)) throw new Error(`Runtime dependency escapes installed packages: ${name}`);
        return resolved;
      }
      if (path.dirname(current) === current) break;
    }
    throw new Error(`Missing runtime dependency: ${name}`);
  }

  function copyContents(source, destination, packageRoot) {
    const resolvedSource = fs.realpathSync(source);
    if (!inside(installedRoot, resolvedSource)) throw new Error("Package file escapes installed packages");
    if (!inside(outputRoot, path.resolve(destination))) throw new Error("Package output escapes artifact");
    const stat = fs.statSync(resolvedSource);
    if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(resolvedSource)) {
        if (entry === ".git" || (resolvedSource === packageRoot && entry === "node_modules")) continue;
        copyContents(path.join(resolvedSource, entry), path.join(destination, entry), packageRoot);
      }
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(resolvedSource, destination);
      fs.chmodSync(destination, stat.mode);
    } else throw new Error("Unsupported installed package entry");
  }

  function visit(name, source, destination, ancestors) {
    if (ancestors.get(name) === source) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    copyContents(source, destination, source);
    packages.push({ name, version: manifest.version });
    const nextAncestors = new Map(ancestors).set(name, source);
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      let resolved;
      try { resolved = resolvePackage(dependency, source); }
      catch (error) {
        if (Object.hasOwn(manifest.optionalDependencies || {}, dependency)
          || manifest.peerDependenciesMeta?.[dependency]?.optional) continue;
        throw error;
      }
      visit(dependency, resolved, path.join(destination, "node_modules", dependency), nextAncestors);
    }
  }

  for (const name of names) {
    visit(name, resolvePackage(name, sourceRoot), path.join(outputRoot, "node_modules", name), new Map());
  }
  return { packageCopies: packages.length, packages };
}

export function materializeStorageRuntime(sourceRoot, artifactRoot) {
  const result = materializeRuntimePackages(sourceRoot, artifactRoot, ["cos-nodejs-sdk-v5"]);
  verifyStorageRuntime(artifactRoot);
  return result;
}

export function materializeWebRuntime(sourceRoot, artifactRoot) {
  const result = materializeRuntimePackages(sourceRoot, artifactRoot, ["next", "react", "react-dom"]);
  verifyStorageRuntime(artifactRoot, { web: true, storage: false });
  return result;
}

/** Complete every package Next actually externalized, preserving its own deps. */
export function materializeTracedRuntime(sourceRoot, standaloneRoot, artifactRoot, { storage = false } = {}) {
  const tracedModules = path.join(standaloneRoot, "node_modules");
  const names = new Set(["next", "react", "react-dom"]);
  for (const entry of fs.readdirSync(tracedModules)) {
    if (entry.startsWith(".")) continue;
    const candidates = entry.startsWith("@")
      ? fs.readdirSync(path.join(tracedModules, entry)).map(child => `${entry}/${child}`)
      : [entry];
    for (const name of candidates) {
      if (fs.existsSync(path.join(tracedModules, name, "package.json"))) names.add(name);
    }
  }
  const result = materializeRuntimePackages(sourceRoot, artifactRoot, [...names].sort());
  verifyStorageRuntime(artifactRoot, { web: true, storage, database: names.has("pg") });
  return { ...result, roots: [...names].sort() };
}

/** Resolving a dependency outside the artifact must fail, even on the builder. */
export function verifyStorageRuntime(artifactRoot, { web = false, storage = true, database = false } = {}) {
  const probe = `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const root = fs.realpathSync(process.cwd());
    const original = Module._resolveFilename;
    Module._resolveFilename = function(...args) {
      const resolved = original.apply(this, args);
      if (path.isAbsolute(resolved)) {
        const relative = path.relative(root, fs.realpathSync(resolved));
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
          throw new Error('ARTIFACT_DEPENDENCY_ESCAPES: ' + args[0]);
        }
      }
      return resolved;
    };
    const scoped = Module.createRequire(path.join(root, 'package.json'));
    if (${JSON.stringify(web)}) {
      const next = scoped('next');
      if (typeof next !== 'function') throw new Error('NEXT_RUNTIME_INVALID');
      scoped('react');
      scoped('react-dom/server');
    }
    if (${JSON.stringify(database)}) {
      const pg = scoped('pg');
      if (typeof pg.Pool !== 'function' || typeof pg.Client !== 'function') throw new Error('PG_RUNTIME_INVALID');
      if (pg.types.getTypeParser(23)('42') !== 42) throw new Error('PG_TYPES_RUNTIME_INVALID');
    }
    if (${JSON.stringify(storage)}) {
      const COS = scoped('cos-nodejs-sdk-v5');
      const client = new COS({ SecretId: 'runtime-probe-placeholder', SecretKey: 'runtime-probe-placeholder' });
      if (typeof client.putObject !== 'function' || typeof client.headObject !== 'function') throw new Error('COS_RUNTIME_INVALID');
    }
    process.stdout.write('COS_RUNTIME_LOAD_OK');
  `;
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: artifactRoot, env, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  if (result.status !== 0 || result.stdout !== "COS_RUNTIME_LOAD_OK") {
    throw new Error(`Storage runtime dependency check failed: ${result.stderr || result.error?.message || result.status}`);
  }
  return { storageSdkLoad: "passed", externalFallback: "forbidden", networkRequests: 0 };
}
