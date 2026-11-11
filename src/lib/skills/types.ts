export interface AgentSkill {
  id: string;
  name: string;
  display_name: string;
  description: string;
  version: string;
  category: string | null;
  tags: string[];
  priority: number;
  is_active: boolean;
  required_tools: string[];
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface SkillResource {
  id: string;
  skill_id: string;
  filename: string;
  content: string | null;
  storage_path: string | null;
  content_type: string;
  is_primary: boolean;
  sort_order: number;
  created_at: string;
}

export interface LoadedSkill extends AgentSkill {
  resources: SkillResource[];
  primaryContent: string | null;
}

export interface SkillSearchOptions {
  query?: string;
  category?: string;
  tags?: string[];
  onlyActive?: boolean;
  limit?: number;
}
