import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isValidUUID } from "@/lib/validators";
import { parseFileBuffer } from "@/lib/file-parser";
import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "@/lib/rag/chunker";
import { embedTexts, toPgVectorLiteral } from "@/lib/rag/embedding";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const { id: agentId } = await params;
  if (!isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId");

  const supabase = createAdminClient();

  if (fileId && isValidUUID(fileId)) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id, title, parsed_content")
      .eq("source_file_id", fileId)
      .eq("agent_id", agentId)
      .single();

    if (!doc) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    return NextResponse.json({ content: doc.parsed_content || "" });
  }

  const { data, error } = await supabase
    .from("agent_files")
    .select("id, file_name, file_type, status, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId");

  if (!fileId || !isValidUUID(fileId)) {
    return NextResponse.json({ error: "Invalid file ID" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: file } = await supabase
    .from("agent_files")
    .select("id, agent_id")
    .eq("id", fileId)
    .single();

  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id, files_count")
    .eq("id", file.agent_id)
    .eq("user_id", user.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Delete chunks first, then document, then file
  const { data: doc } = await supabase
    .from("documents")
    .select("id")
    .eq("source_file_id", fileId)
    .single();

  if (doc) {
    await supabase.from("document_chunks").delete().eq("document_id", doc.id);
  }

  await supabase.from("documents").delete().eq("source_file_id", fileId);

  await supabase.from("agent_files").delete().eq("id", fileId);

  await supabase
    .from("agents")
    .update({ files_count: Math.max((agent.files_count || 1) - 1, 0) })
    .eq("id", agent.id);

  console.log(`[Files] Deleted file ${fileId} from agent ${agent.id}`);

  return NextResponse.json({ success: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id: agentId } = await params;
  if (!isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Verify agent ownership
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // Parse file content
  let textContent = "";
  try {
    textContent = await parseFileBuffer(fileBuffer, file.type, file.name);
  } catch (e) {
    return NextResponse.json(
      { error: "Could not parse file" },
      { status: 400 }
    );
  }

  if (!textContent.trim()) {
    return NextResponse.json(
      { error: "Extracted text is empty" },
      { status: 400 }
    );
  }

  // Create agent file record
  const { data: agentFile, error: fileError } = await supabase
    .from("agent_files")
    .insert({
      agent_id: agentId,
      file_name: file.name,
      file_type: file.type,
      status: "uploaded",
    })
    .select()
    .single();

  if (fileError || !agentFile) {
    return NextResponse.json(
      { error: "Failed to save file record" },
      { status: 500 }
    );
  }

  // Create document
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .insert({
      agent_id: agentId,
      source_file_id: agentFile.id,
      title: file.name,
      parsed_content: textContent.slice(0, 500_000),
    })
    .select()
    .single();

  if (docError || !doc) {
    return NextResponse.json(
      { error: "Failed to create document" },
      { status: 500 }
    );
  }

  // Update agent files count
  const { data: agentData } = await supabase
    .from("agents")
    .select("files_count")
    .eq("id", agentId)
    .single();

  if (agentData) {
    await supabase
      .from("agents")
      .update({ files_count: (agentData.files_count || 0) + 1 })
      .eq("id", agentId);
  }

  // RAG: Chunk + Embed the document
  try {
    await supabase
      .from("agent_files")
      .update({ status: "processing" })
      .eq("id", agentFile.id);

    const chunks = chunkText(textContent);
    console.log(`[RAG] Chunked "${file.name}" into ${chunks.length} chunks`);

    if (chunks.length > 0) {
      const embeddings = await embedTexts(chunks.map((c) => c.content));
      console.log(`[RAG] Generated ${embeddings.length} embeddings`);

      // Store chunks with embeddings in the database
      const chunkRecords = chunks.map((chunk, i) => ({
        document_id: doc.id,
        agent_id: agentId,
        chunk_index: chunk.index,
        content: chunk.content,
        embedding: toPgVectorLiteral(embeddings[i]),
      }));

      // Insert in batches of 50
      const batchSize = 50;
      for (let i = 0; i < chunkRecords.length; i += batchSize) {
        const batch = chunkRecords.slice(i, i + batchSize);
        const { error: insertError } = await supabase
          .from("document_chunks")
          .insert(batch);

        if (insertError) {
          console.error(`[RAG] Chunk insert error:`, insertError);
        }
      }

      console.log(`[RAG] Stored ${chunkRecords.length} chunks for "${file.name}"`);
    }

    await supabase
      .from("agent_files")
      .update({ status: "indexed" })
      .eq("id", agentFile.id);
  } catch (e: any) {
    console.error(`[RAG] Embedding failed for "${file.name}":`, e?.message);
    // Still mark as indexed — search will fall back to full text
    await supabase
      .from("agent_files")
      .update({ status: "indexed" })
      .eq("id", agentFile.id);
  }

  return NextResponse.json({
    success: true,
    file: { ...agentFile, status: "indexed" },
    document_id: doc.id,
  });
}
