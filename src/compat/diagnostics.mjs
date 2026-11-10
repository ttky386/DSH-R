const helper = new URL('../runtime-diagnostics.mjs', import.meta.url).href

/** 只有已核函数边界各出现一次才插入观察点；结构变化原样返回。 */
export function diagnosticSource(source, kind) {
  const replacements = kind === 'cordis' ? [
    ['if (result.issues) throw new ValidationError(result.issues);', 'if (result.issues) throw dshDiagnostic.schemaError(new ValidationError(result.issues));'],
    ['\t_execute(runner) {\n', '\t_execute(runner) {\n\t\tdshDiagnostic.execute(this, runner);\n'],
    ['\t\t\tthis.store[key] = impl;\n', '\t\t\tthis.store[key] = impl;\n\t\t\tdshDiagnostic.serviceProvided(this, key, impl);\n'],
    ['\tasync _unload() {\n', '\tasync _unload() {\n\t\tdshDiagnostic.beforeUnload(this, symbols.isolate);\n'],
    ['\tasync _reload() {\n', '\tasync _reload() {\n\t\tdshDiagnostic.reload(this);\n'],
    ['return this.runtime ? resolveConfig(this.runtime, config) : config;', 'return this.runtime ? dshDiagnostic.validate(this, () => resolveConfig(this.runtime, config), config) : config;'],
  ] : kind === 'boot' ? [
    ['\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);', '\t\tdshDiagnostic.registerBoot(ctx, requiredStartupEntryIds);\n\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);'],
    ['\tconst includeId = await ctx.loader.create(rootInclude);', '\tdshDiagnostic.registerRoot(ctx, rootInclude);\n\tconst includeId = await ctx.loader.create(rootInclude);'],
    ['\t\tif (exiting) return;\n\t\texiting = true;\n', '\t\tif (exiting) return;\n\t\texiting = true;\n\t\tdshDiagnostic.fatal(err);\n'],
    ['\tconst required = new Set(failures.filter(({ entry }) => entry === bootstrapIncludes.get(ctx) || requiredStartupEntryIds.has(entry.options.id)).map(({ entry }) => entry));', '\tconst required = new Set(failures.filter(({ entry }) => entry === bootstrapIncludes.get(ctx) || requiredStartupEntryIds.has(entry.options.id)).map(({ entry }) => entry));\n\tdshDiagnostic.audit(ctx, failures, required, bootstrapIncludes.get(ctx));'],
  ] : kind === 'loader' ? [
    ['\t\t\tmoduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack);\n\t\t} catch (error) {', '\t\t\tmoduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack);\n\t\t} catch (error) {\n\t\t\tdshDiagnostic.importFailure(this, error);'],
  ] : []
  if (!replacements.length || replacements.some(([from]) => source.split(from).length !== 2)) {
    return null
  }
  let result = source
  for (const [from, to] of replacements) {
    result = result.replace(from, to)
  }
  if (kind === 'cordis') {
    const capture = '\t_resolveConfig(config) {\n'
    const service = 'export { Context, '
    if (result.split(capture).length === 2 && result.split(service).length === 2) {
      result = result.replace(capture, capture + '\t\tdshDiagnostic.configurationStart(this);\n')
      result = result.replace(service, 'dshDiagnostic.registerServiceClass(Service, symbols.isolate);\n' + service)
    }
  }
  return `import { runtimeDiagnostics as dshDiagnostic } from ${JSON.stringify(helper)};\n${result}`
}

export function load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (!process.env.DSH_X_DIAGNOSTIC_ATTEMPT || result.format !== 'module' || result.source === undefined) {
    return result
  }
  const kind = url.endsWith('/@deepseek-ai/cordis/lib/index.js') ? 'cordis' : url.endsWith('/@deepseek-ai/dsh-app-boot/lib/index.js') ? 'boot' : url.endsWith('/@deepseek-ai/cordis-plugin-loader/lib/index.js') ? 'loader' : null
  if (!kind) {
    return result
  }
  try {
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source)
    const patched = diagnosticSource(source, kind)
    return patched ? { ...result, source: patched } : result
  } catch {
    return result
  }
}
