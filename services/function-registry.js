/**
 * Function Registry Service
 * Provider-agnostic infrastructure for handling LLM function calls
 *
 * Functions are registered with name "funcName" and called via "call<FuncName>" pattern
 * This service is independent of the LLM provider (OpenAI, Anthropic, etc.)
 */
class FunctionRegistry {
  constructor() {
    // Map of function name -> handler function
    this.functions = new Map();
  }

  /**
   * Register a function that can be called by LLM
   * @param {string} name - Function name (e.g., "getWeather", "searchDatabase")
   * @param {Function} handler - Async function that receives params object and returns result
   * @param {Object} schema - Optional JSON schema for function parameters (for LLM tool definition)
   */
  register(name, handler, schema = null) {
    if (typeof handler !== 'function') {
      throw new Error(`Handler for "${name}" must be a function`);
    }

    this.functions.set(name, {
      handler,
      schema
    });

    console.log(`📝 Function registered: ${name}`);
  }

  /**
   * Unregister a function
   * @param {string} name - Function name to remove
   */
  unregister(name) {
    if (this.functions.has(name)) {
      this.functions.delete(name);
      console.log(`🗑️ Function unregistered: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Check if a function is registered
   * @param {string} name - Function name
   * @returns {boolean}
   */
  has(name) {
    return this.functions.has(name);
  }

  /**
   * Get all registered function names
   * @returns {string[]}
   */
  list() {
    return Array.from(this.functions.keys());
  }

  /**
   * Get function schemas for LLM tool definitions
   * @returns {Object[]} Array of function schemas
   */
  getSchemas() {
    const schemas = [];
    for (const [name, { schema }] of this.functions.entries()) {
      if (schema) {
        schemas.push({
          name,
          ...schema
        });
      }
    }
    return schemas;
  }

  /**
   * Parse a function call from LLM output
   * Supports multiple formats:
   *   - call_report_symptom -> report_symptom
   *   - callReportSymptom -> reportSymptom
   *   - call<FuncName> -> funcName
   * @param {string} callName - The call name from LLM
   * @returns {string|null} - The function name or null if not a valid call
   */
  parseFunctionName(callName) {
    // Format 1: snake_case with call_ prefix (e.g., "call_report_symptom")
    if (callName.startsWith('call_')) {
      return callName.substring(5); // Remove "call_" prefix
    }

    // Format 2: camelCase callFuncName (e.g., "callReportSymptom")
    const camelMatch = callName.match(/^call([A-Z][a-zA-Z0-9]*)$/);
    if (camelMatch) {
      // Convert first letter to lowercase for camelCase function name
      return camelMatch[1].charAt(0).toLowerCase() + camelMatch[1].slice(1);
    }

    // Format 3: Just starts with "call" followed by anything
    if (callName.startsWith('call')) {
      return callName.substring(4);
    }

    return null;
  }

  /**
   * Execute a function by call name
   * @param {string} callName - The call name (e.g., "callGetWeather")
   * @param {Object} params - JSON parameters for the function
   * @returns {Promise<Object>} - Function result
   */
  async execute(callName, params = {}) {
    const funcName = this.parseFunctionName(callName);

    if (!funcName) {
      throw new Error(`Invalid function call format: "${callName}". Expected format: call<FuncName>`);
    }

    if (!this.functions.has(funcName)) {
      throw new Error(`Function "${funcName}" is not registered`);
    }

    const { handler } = this.functions.get(funcName);

    console.log(`🔧 Executing function: ${funcName}`, JSON.stringify(params));

    try {
      const result = await handler(params);
      console.log(`✅ Function ${funcName} completed`);
      return result;
    } catch (error) {
      console.error(`❌ Function ${funcName} failed:`, error.message);
      throw error;
    }
  }

  /**
   * Execute a function directly by name (not call format)
   * @param {string} funcName - The function name (e.g., "getWeather")
   * @param {Object} params - JSON parameters for the function
   * @returns {Promise<Object>} - Function result
   */
  async executeByName(funcName, params = {}) {
    if (!this.functions.has(funcName)) {
      throw new Error(`Function "${funcName}" is not registered`);
    }

    const { handler } = this.functions.get(funcName);

    console.log(`🔧 Executing function: ${funcName}`, JSON.stringify(params));

    try {
      const result = await handler(params);
      console.log(`✅ Function ${funcName} completed`);
      return result;
    } catch (error) {
      console.error(`❌ Function ${funcName} failed:`, error.message);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new FunctionRegistry();
