import { createClient } from '@/lib/supabase/server';
import type { LoadedSkill, SkillResource } from './types';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export class SkillLoader {
  private supabase: SupabaseServerClient;

  constructor(supabaseClient: SupabaseServerClient) {
    this.supabase = supabaseClient;
  }

  async loadSkill(skillName: string): Promise<LoadedSkill | null> {
    const { data: skill, error: skillError } = await this.supabase
      .from('agent_skills')
      .select('*')
      .eq('name', skillName)
      .eq('is_active', true)
      .single();

    if (skillError || !skill) {
      console.error(`Skill not found: ${skillName}`, skillError);
      return null;
    }

    const { data: resources, error: resError } = await this.supabase
      .from('skill_resources')
      .select('*')
      .eq('skill_id', skill.id)
      .order('sort_order', { ascending: true });

    if (resError) {
      console.error(`Error loading resources for skill: ${skillName}`, resError);
      throw resError;
    }

    const skillResources: SkillResource[] = resources || [];
    const primaryResource =
      skillResources.find((r) => r.is_primary) || skillResources[0];

    return {
      ...skill,
      resources: skillResources,
      primaryContent: primaryResource ? primaryResource.content : null,
    };
  }

  async logUsage(
    skillId: string,
    conversationId: string,
    tokensUsed: number,
    latencyMs: number,
    success: boolean,
    errorMessage?: string
  ) {
    await this.supabase.from('skill_usage_logs').insert({
      skill_id: skillId,
      conversation_id: conversationId,
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
      success,
      error_message: errorMessage || null,
    });
  }
}