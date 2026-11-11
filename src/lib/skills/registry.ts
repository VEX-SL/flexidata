import { createClient } from '@/lib/supabase/server';
import type { AgentSkill, SkillSearchOptions } from './types';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type PartialAgentSkill = Partial<AgentSkill>;

export class SkillsRegistry {
  private supabase: SupabaseServerClient;

  private static cache: PartialAgentSkill[] | null = null;
  private static cacheTimestamp = 0;
  private static CACHE_TTL = 1000 * 60 * 5; // 5 minutes

  constructor(supabaseClient: SupabaseServerClient) {
    this.supabase = supabaseClient;
  }

  async listActiveSkills(): Promise<PartialAgentSkill[]> {
    const now = Date.now();
    if (
      SkillsRegistry.cache &&
      now - SkillsRegistry.cacheTimestamp < SkillsRegistry.CACHE_TTL
    ) {
      return SkillsRegistry.cache;
    }

    const { data, error } = await this.supabase
      .from('agent_skills')
      .select('id, name, display_name, description, category, tags, priority')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching active skills:', error);
      throw error;
    }

    SkillsRegistry.cache = data ?? [];
    SkillsRegistry.cacheTimestamp = now;

    return SkillsRegistry.cache;
  }

  async searchSkills(options: SkillSearchOptions): Promise<AgentSkill[]> {
    let queryBuilder = this.supabase.from('agent_skills').select('*');

    if (options.onlyActive !== false) {
      queryBuilder = queryBuilder.eq('is_active', true);
    }

    if (options.category) {
      queryBuilder = queryBuilder.eq('category', options.category);
    }

    if (options.tags && options.tags.length > 0) {
      queryBuilder = queryBuilder.overlaps('tags', options.tags);
    }

    if (options.limit) {
      queryBuilder = queryBuilder.limit(options.limit);
    }

    const { data, error } = await queryBuilder.order('priority', {
      ascending: false,
    });

    if (error) {
      console.error('Error searching skills:', error);
      throw error;
    }

    return data || [];
  }

  public static invalidateCache() {
    SkillsRegistry.cache = null;
    SkillsRegistry.cacheTimestamp = 0;
  }
}