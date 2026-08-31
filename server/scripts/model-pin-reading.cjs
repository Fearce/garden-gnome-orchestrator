// Pure reading behind probe-task-runs' strict-model assertion mode. Keeping this
// separate makes the fail-closed verdict cheap to test without opening the live DB.

function parseProbeArgs(argv) {
  const queryParts = [];
  let showPrompt = false;
  let verifyModelPin = false;
  let expectedModel = null;

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--prompt") {
      showPrompt = true;
      continue;
    }
    if (value === "--verify-model-pin") {
      verifyModelPin = true;
      continue;
    }
    if (value === "--expect-model") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error("--expect-model requires a canonical model id");
      expectedModel = next;
      verifyModelPin = true;
      i += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    queryParts.push(value);
  }

  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("a thread id or title substring is required");
  return { query, showPrompt, verifyModelPin, expectedModel };
}

function parsePersistedModelRequest(raw) {
  try {
    const value = JSON.parse(raw || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    const text = String(raw ?? "").replace(/\s+/g, " ");
    return { invalid: text.length > 120 ? `${text.slice(0, 119)}…` : text };
  }
}

function providerForRun(run) {
  const account = String(run?.account ?? "");
  const separator = account.indexOf(":");
  return separator > 0 ? account.slice(0, separator) : "claude";
}

function modelPinReading({ modelRequest, runs, expectedModel = null }) {
  const implementorRuns = runs
    .filter((run) => run.role === "implementor")
    .sort((a, b) => Number(a.started_at ?? 0) - Number(b.started_at ?? 0));
  const latest = implementorRuns.at(-1) ?? null;
  const errors = [];

  let requestedModel = null;
  let requestedProvider = null;
  let strict = false;
  if (!modelRequest) {
    errors.push("no persisted model request exists");
  } else if (modelRequest.invalid != null) {
    errors.push(`persisted model request is malformed: ${modelRequest.invalid}`);
  } else {
    requestedModel = typeof modelRequest.model === "string" && modelRequest.model.trim()
      ? modelRequest.model.trim()
      : null;
    requestedProvider = typeof modelRequest.provider === "string" && modelRequest.provider.trim()
      ? modelRequest.provider.trim()
      : null;
    strict = modelRequest.strict === true;
    if (!strict) errors.push("persisted model request is not strict");
    if (!requestedModel) errors.push("persisted model request has no resolved canonical model");
    if (!requestedProvider) errors.push("persisted model request has no resolved provider");
  }

  const actualModel = typeof latest?.model === "string" ? latest.model : null;
  const actualProvider = latest ? providerForRun(latest) : null;
  if (!latest) {
    errors.push("no implementor agent_run exists");
  } else {
    if (requestedModel && actualModel !== requestedModel) {
      errors.push(`latest implementor model is ${actualModel ?? "missing"}, requested ${requestedModel}`);
    }
    if (requestedProvider && actualProvider !== requestedProvider) {
      errors.push(`latest implementor provider is ${actualProvider ?? "missing"}, requested ${requestedProvider}`);
    }
  }

  if (expectedModel) {
    if (requestedModel !== expectedModel) {
      errors.push(`persisted requested model is ${requestedModel ?? "missing"}, expected ${expectedModel}`);
    }
    if (actualModel !== expectedModel) {
      errors.push(`latest implementor model is ${actualModel ?? "missing"}, expected ${expectedModel}`);
    }
  }

  return {
    ok: errors.length === 0,
    expectedModel,
    requestedModel,
    requestedProvider,
    strict,
    actualModel,
    actualProvider,
    account: latest?.account ?? null,
    runState: latest?.state ?? null,
    runStartedAt: latest?.started_at ?? null,
    errors,
  };
}

module.exports = { modelPinReading, parsePersistedModelRequest, parseProbeArgs, providerForRun };
