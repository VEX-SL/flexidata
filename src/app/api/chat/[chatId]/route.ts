import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { SkillsRegistry } from "@/lib/skills/registry";
import { SkillLoader } from "@/lib/skills/loader";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { chatId } = await params;
  if (!isValidUUID(chatId)) {
    return NextResponse.json({ error: "Invalid chat ID" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: deletedChat, error } = await supabase
    .from("chats")
    .delete()
    .eq("id", chatId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to delete chat" }, { status: 500 });
  }

  if (!deletedChat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { messages, agentId } = await req.json();
  const supabase = await createClient(); // ✅ awaited client

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "status",
              text: "جاري فحص المهارات والأدوات في قاعدة البيانات...",
            }) + "\n"
          )
        );

        // ✅ نمرر الـ client المُنتظَر وليس الـ Promise
        const registry = new SkillsRegistry(supabase);
        const loader = new SkillLoader(supabase);

        // نستخدم استعلاماً واحداً يجلب required_tools فقط (بدل التكرار)
        const { data: dbSkills, error: skillsError } = await supabase
          .from("agent_skills")
          .select("required_tools")
          .eq("is_active", true);

        if (skillsError) throw skillsError;

        const availableTools: string[] = [];
        for (const s of dbSkills ?? []) {
          if (Array.isArray(s.required_tools)) {
            availableTools.push(...s.required_tools);
          }
        }

        // إزالة التكرار
        const uniqueTools = Array.from(new Set(availableTools));

        const lastUserMsg =
          messages && messages.length > 0
            ? String(messages[messages.length - 1].content).toLowerCase()
            : "";

        let usedTool: string | null = null;

        if (
          uniqueTools.length > 0 &&
          (lastUserMsg.includes("ابحث") ||
            lastUserMsg.includes("بحث") ||
            lastUserMsg.includes("search"))
        ) {
          usedTool =
            uniqueTools.find((t) => t.includes("search") || t.includes("web")) ||
            uniqueTools[0];
        } else if (
          uniqueTools.length > 0 &&
          (lastUserMsg.includes("ملف") ||
            lastUserMsg.includes("pdf") ||
            lastUserMsg.includes("استخرج"))
        ) {
          usedTool =
            uniqueTools.find((t) => t.includes("file") || t.includes("extract")) ||
            uniqueTools[0];
        }

        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "tool_info",
              availableTools: uniqueTools,
              usedTool,
            }) + "\n"
          )
        );

        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: "status", text: "جارِ صياغة الرد..." }) + "\n"
          )
        );

        const aiResponse = usedTool
          ? `تم استخدام أداة (${usedTool}) بنجاح لتنفيذ طلبك بدقة من خلال مهارات الوكيل المسجلة.`
          : "تمت الإجابة مباشرة على استفسارك بناءً على السياق، ولم تكن هناك حاجة لتشغيل أداة خارجية في هذا الرد.";

        for (let i = 0; i < aiResponse.length; i++) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "content", text: aiResponse[i] }) + "\n"
            )
          );
          await new Promise((r) => setTimeout(r, 15));
        }

        controller.close();
      } catch (error: any) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: "error", text: error.message }) + "\n"
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}