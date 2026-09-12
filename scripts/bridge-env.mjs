// PEM needs escaped newlines; JSON must remain unquoted to avoid preserving \" escapes.
export function serializeBridgeEnvironment(values) {
  const names = [
    'MCP_BRIDGE_PRIVATE_KEY',
    'MCP_BRIDGE_JWKS',
    'MCP_BRIDGE_KEY_ID',
    'MCP_BRIDGE_CLIENT_ID',
    'MCP_BRIDGE_CLIENT_SECRET',
  ];
  return names
    .map((name) => {
      const value = values[name];
      if (typeof value !== 'string' || !value)
        throw new Error('Missing bridge configuration');
      if (name !== 'MCP_BRIDGE_PRIVATE_KEY' && /[\r\n]/.test(value))
        throw new Error('Invalid single-line bridge configuration');
      return `${name}=${name === 'MCP_BRIDGE_PRIVATE_KEY' ? JSON.stringify(value) : value}`;
    })
    .join('\n');
}
