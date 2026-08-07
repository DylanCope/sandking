/** @param {string} name */
const launchInputId = (name) => `harness-launch-parameter-${name}`;

/**
 * Render only the fields declared by the focused pinned Harness.
 * @param {Document} document
 * @param {{kind: "none"} | {kind: "fields", fields: any[]}} declaration
 */
export const renderHarnessLaunchParameterFields = (document, declaration) => {
  const container = document.createElement("div");
  container.id = "harness-launch-parameters";
  container.dataset.parameterKind = declaration?.kind === "fields" ? "fields" : "none";
  const fields = declaration?.kind === "fields" ? declaration.fields : [];
  container.dataset.parameterCount = String(fields.length);
  for (const field of fields) {
    const label = document.createElement("label");
    label.htmlFor = launchInputId(field.name);
    label.textContent = field.label;
    /** @type {HTMLInputElement | HTMLSelectElement} */
    let input;
    if (field.valueType === "boolean") {
      input = document.createElement("select");
      for (const [value, text] of [["", "Not supplied"], ["true", "Yes"], ["false", "No"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
    } else {
      input = document.createElement("input");
      input.type = field.valueType === "integer" ? "number" : "text";
      if (field.valueType === "integer") {
        input.min = String(field.minimum);
        input.max = String(field.maximum);
        input.step = "1";
        input.inputMode = "numeric";
      } else {
        input.minLength = field.minLength;
        input.maxLength = field.maxLength;
        input.autocomplete = "off";
      }
    }
    input.id = launchInputId(field.name);
    input.name = field.name;
    input.dataset.launchParameter = field.name;
    input.dataset.valueType = field.valueType;
    input.required = field.required;
    container.append(label, input);
    if (field.description) {
      const description = document.createElement("p");
      description.dataset.launchParameterDescription = field.name;
      description.textContent = field.description;
      container.append(description);
    }
  }
  return container;
};

/**
 * Read and validate the currently rendered declaration without knowing any
 * Harness-specific parameter names.
 * @param {HTMLElement} container
 * @param {{kind: "none"} | {kind: "fields", fields: any[]}} declaration
 */
export const readHarnessLaunchParameters = (container, declaration) => {
  const fields = declaration?.kind === "fields" ? declaration.fields : [];
  /** @type {Record<string, string | number | boolean>} */
  const parameters = {};
  for (const field of fields) {
    const input = /** @type {HTMLInputElement | HTMLSelectElement | null} */ (
      container.querySelector(`[data-launch-parameter="${field.name}"]`)
    );
    if (!input) return { ok: false, error: "declared parameter field is unavailable" };
    const raw = input.value.trim();
    if (raw === "") {
      if (field.required) return { ok: false, error: `${field.label} is required` };
      continue;
    }
    if (field.valueType === "integer") {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < field.minimum || value > field.maximum) {
        return { ok: false, error: `${field.label} is invalid` };
      }
      parameters[field.name] = value;
    } else if (field.valueType === "string") {
      if (raw.length < field.minLength || raw.length > field.maxLength) {
        return { ok: false, error: `${field.label} is invalid` };
      }
      parameters[field.name] = raw;
    } else {
      parameters[field.name] = raw === "true";
    }
  }
  return { ok: true, parameters };
};
