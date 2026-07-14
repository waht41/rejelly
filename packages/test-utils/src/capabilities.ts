export interface TestCapabilities {
  basicStream: boolean;
  toolCall: boolean;
  toolChoice: boolean;
  nativeSchema: boolean;
  reasoning: boolean;
}

export type CapabilityName = keyof TestCapabilities;
