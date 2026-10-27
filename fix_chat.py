with open("src/app/(dashboard)/chat/page.tsx", "r") as f:
    lines = f.read().splitlines()
# Remove line with only <div> near middle (line 406 after restore)
for i in range(400, 410):
    if lines[i].strip() == "<div>":
        del lines[i]
        break
# Remove stray closing </div> near end
for i in range(len(lines)-1, 400, -1):
    if lines[i].strip() == "</div>":
        del lines[i]
        break
# Find second ConfirmDialog block and delete it
count = 0
s = None
for i, l in enumerate(lines):
    if l.strip() == "{deleteDialog.isOpen && (":
        count += 1
        if count == 2:
            s = i
            break
if s is not None:
    for i in range(s, len(lines)):
        if lines[i].strip() in (")}", ")})"):
            del lines[s:i+1]
            break
# Insert closing </div> for root div before );
for i in range(len(lines)-10, len(lines)):
    if lines[i].strip() == ");":
        lines.insert(i, "    </div>")
        break
with open("src/app/(dashboard)/chat/page.tsx", "w") as f:
    f.write("\n".join(lines) + "\n")
print("Fixed.")
