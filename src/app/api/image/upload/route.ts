import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    console.log(`[Image Upload] Uploading ${file.name} (${(file.size / 1024).toFixed(1)}KB) to catbox.moe...`);

    const catboxForm = new FormData();
    catboxForm.append("reqtype", "fileupload");
    catboxForm.append("fileToUpload", file);

    const res = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: catboxForm,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Catbox upload failed: ${res.status}`);
    }

    const url = (await res.text()).trim();
    if (!url.startsWith("https://")) {
      throw new Error(`Invalid catbox response: ${url}`);
    }

    console.log(`[Image Upload] Uploaded → ${url}`);
    return NextResponse.json({ url, name: file.name, size: file.size });
  } catch (e: any) {
    console.error("[Image Upload]", e);
    return NextResponse.json({ error: e?.message || "Upload failed" }, { status: 500 });
  }
}
