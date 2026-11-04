import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function handleUpdate(
  request: Request,
  context: { params: Promise<{ chatId: string }> }
) {
  try {
    const params = await context.params;
    const chatId = params.chatId;

    if (!chatId) {
      return NextResponse.json({ error: "Missing Chat ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { title, pinned, pinned_at } = body;

    const updateData: Record<string, any> = {};
    if (title !== undefined) updateData.title = title;
    if (pinned !== undefined) updateData.pinned = pinned;
    if (pinned_at !== undefined) updateData.pinned_at = pinned_at;

    const { data, error } = await supabase
      .from("chats")
      .update(updateData)
      .eq("id", chatId)
      .select();

    if (error) {
      console.error("Supabase Update Error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data?.[0] || {});
  } catch (err: any) {
    console.error("Server Route Error:", err);
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}

// دعم PATCH و POST لتفادي أي خطأ 405 Method Not Allowed
export async function PATCH(request: Request, context: { params: Promise<{ chatId: string }> }) {
  return handleUpdate(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ chatId: string }> }) {
  return handleUpdate(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ chatId: string }> }
) {
  try {
    const params = await context.params;
    const chatId = params.chatId;

    if (!chatId) {
      return NextResponse.json({ error: "Missing Chat ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { error } = await supabase
      .from("chats")
      .delete()
      .eq("id", chatId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}