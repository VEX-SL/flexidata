with open('F:\\H\\flexidata\\src\\app\\(dashboard)\\chat\\page.tsx', 'r') as f:
    content = f.read()

# The ConfirmDialog is outside the closing div - need to move it inside
old_text = "      </div>\n\n      {/* ── Delete Confirmation Dialog ── */}\n      <ConfirmDialog"
new_text = "      </div>\n      {/* ── Delete Confirmation Dialog ── */}\n      <ConfirmDialog"

content = content.replace(old_text, new_text)

# Now also fix the closing tags - ConfirmDialog should be before the root div closes
old_text2 = "        type=\"danger\"\n      />\n    </div>\n  );"
new_text2 = "        type=\"danger\"\n      />\n    </div>\n  );"
# This is already correct - ConfirmDialog is now before </div>

with open('F:\\H\\flexidata\\src\\app\\(dashboard)\\chat\\page.tsx', 'w') as f:
    f.write(content)
print('Fixed ConfirmDialog placement')
