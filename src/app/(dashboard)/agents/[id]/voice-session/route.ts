import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/agents/[id]/voice-session
// بيجيب آخر شات للمستخدم مع الوكيل، أو بينشئ واحد جديد
// النتيجة: نفس الـ chatId بتاع الشات النصي → الرسايل الصوتية والنصية في شات واحد
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: agentId } = await params;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createAdminClient();

    // جرّب تجيب آخر شات لهذا الوكيل
    const { data: existing } = await supabaseAdmin
      .from("chats")
      .select("id")
      .eq("user_id", user.id)
      .eq("agent_id", agentId) // ← تأكد إن الاسم مطابق للعمود عندك في جدول chats
      .order("updated_at", { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      return new Response(JSON.stringify({ chatId: existing[0].id }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // مفيش شات قديم → أنشئ واحد جديد
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("name")
      .eq("id", agentId)
      .single();

    const { data: created, error } = await supabaseAdmin
      .from("chats")
      .insert({
        user_id: user.id,
        agent_id: agentId, // ← نفس الملاحظة
        title: agent?.name ? `محادثة ${agent.name}` : "محادثة صوتية",
      })
      .select("id")
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ chatId: created.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Voice session error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}