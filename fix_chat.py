with open('F:\\H\\flexidata\\src\\app\\(dashboard)\\chat\\page.tsx', 'r') as f:
    content = f.read()

old_text = '        type="danger"\n      />\n  );'
new_text = '        type="danger"\n      />\n    </div>\n  );'

content = content.replace(old_text, new_text)

with open('F:\\H\\flexidata\\src\\app\\(dashboard)\\chat\\page.tsx', 'w') as f:
    f.write(content)

print('Fixed!')
