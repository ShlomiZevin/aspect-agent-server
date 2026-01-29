/**
 * Common Tools Utility
 *
 * Shared tool definitions and implementations that multiple crew members can use.
 * Tools are functions that the LLM can call during conversation.
 */

/**
 * Common tool definitions with schemas and handlers
 */
const commonTools = {
  /**
   * Update a collected field value
   * Used to store information gathered from the user
   */
  updateField: {
    name: 'update_field',
    description: 'Update a collected field value from the conversation',
    parameters: {
      type: 'object',
      properties: {
        fieldName: {
          type: 'string',
          description: 'Name of the field to update'
        },
        fieldValue: {
          type: 'string',
          description: 'Value to store for this field'
        }
      },
      required: ['fieldName', 'fieldValue']
    },
    handler: async (params, context) => {
      console.log(`📝 Updating field: ${params.fieldName} = ${params.fieldValue}`);
      return {
        success: true,
        field: params.fieldName,
        value: params.fieldValue,
        message: `Field "${params.fieldName}" has been updated.`
      };
    }
  },

  /**
   * Log an event for analytics
   */
  logEvent: {
    name: 'log_event',
    description: 'Log a user interaction or event for analytics purposes',
    parameters: {
      type: 'object',
      properties: {
        eventType: {
          type: 'string',
          description: 'Type of event (e.g., "user_action", "milestone", "error")'
        },
        eventData: {
          type: 'object',
          description: 'Additional data about the event'
        }
      },
      required: ['eventType']
    },
    handler: async (params, context) => {
      console.log(`📊 Event logged: ${params.eventType}`, params.eventData || {});
      return {
        logged: true,
        eventType: params.eventType,
        timestamp: new Date().toISOString()
      };
    }
  }
};

/**
 * Get a tool definition by name
 *
 * @param {string} name - Tool name
 * @returns {Object|null} - Tool definition or null
 */
function getTool(name) {
  return commonTools[name] || null;
}

/**
 * Get multiple tools by names
 *
 * @param {Array<string>} names - Array of tool names
 * @returns {Array} - Array of tool definitions
 */
function getTools(names) {
  return names.map(name => commonTools[name]).filter(Boolean);
}

/**
 * Get all available common tools
 *
 * @returns {Array} - Array of all tool definitions
 */
function getAllTools() {
  return Object.values(commonTools);
}

/**
 * Get tool schemas formatted for OpenAI
 *
 * @param {Array<string>} toolNames - Optional array of tool names to include
 * @returns {Array} - Array of tool schemas
 */
function getToolSchemas(toolNames = null) {
  const tools = toolNames ? getTools(toolNames) : getAllTools();

  return tools.map(tool => ({
    type: 'function',
    name: `call_${tool.name}`,
    description: tool.description,
    parameters: tool.parameters
  }));
}

/**
 * Execute a common tool by name
 *
 * @param {string} toolName - Name of the tool (without "call_" prefix)
 * @param {Object} params - Tool parameters
 * @param {Object} context - Execution context
 * @returns {Object} - Tool execution result
 */
async function executeTool(toolName, params, context = {}) {
  // Remove "call_" prefix if present
  const cleanName = toolName.replace(/^call_/, '');

  const tool = commonTools[cleanName];
  if (!tool) {
    throw new Error(`Unknown common tool: ${cleanName}`);
  }

  return tool.handler(params, context);
}

module.exports = {
  commonTools,
  getTool,
  getTools,
  getAllTools,
  getToolSchemas,
  executeTool
};
