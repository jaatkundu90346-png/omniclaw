from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = Path(__file__).parent / "wireframes"
OUT.mkdir(parents=True, exist_ok=True)
FONT_DIR = Path("C:/Windows/Fonts")


def font(size, weight="regular"):
    names = {
        "regular": ["segoeui.ttf", "arial.ttf"],
        "bold": ["segoeuib.ttf", "arialbd.ttf"],
        "semibold": ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"],
        "mono": ["CascadiaMono.ttf", "consola.ttf"],
        "serif": ["georgia.ttf", "times.ttf"],
    }
    for name in names.get(weight, names["regular"]):
        path = FONT_DIR / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def draw_text(draw, xy, value, size=16, fill="#111111", weight="regular"):
    draw.text(xy, value, font=font(size, weight), fill=fill)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def shadowed(base, box, radius, fill, outline=None, shadow="#000000", blur=16, offset=(0, 8), alpha=45):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(layer)
    sx1, sy1, sx2, sy2 = [int(v) for v in box]
    ox, oy = offset
    sd.rounded_rectangle((sx1 + ox, sy1 + oy, sx2 + ox, sy2 + oy), radius=radius, fill=shadow + f"{alpha:02x}")
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)
    d = ImageDraw.Draw(base)
    rounded(d, box, radius, fill, outline)
    return d


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (w, h), top)
    pix = img.load()
    top_rgb = tuple(int(top[i : i + 2], 16) for i in (1, 3, 5))
    bot_rgb = tuple(int(bottom[i : i + 2], 16) for i in (1, 3, 5))
    for y in range(h):
        t = y / max(h - 1, 1)
        color = tuple(int(top_rgb[i] * (1 - t) + bot_rgb[i] * t) for i in range(3))
        for x in range(w):
            pix[x, y] = color
    return img.convert("RGBA")


def pill(draw, box, label, fill, text_fill, size=13, bold=False):
    rounded(draw, box, (box[3] - box[1]) // 2, fill)
    draw_text(draw, (box[0] + 18, box[1] + 8), label, size, text_fill, "semibold" if bold else "regular")


def dot(draw, x, y, color):
    draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color)


def desktop_workbench():
    img = vertical_gradient((1440, 900), "#f6f2ea", "#ebe6de")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 68, 900), fill="#111214")
    d.rectangle((68, 0, 334, 900), fill="#1b1c1e")
    d.rectangle((1036, 0, 1440, 900), fill="#ece7de")

    draw_text(d, (23, 30), "O", 26, "#f5efe6", "bold")
    for y, label, active in [(110, "+", True), (178, "T", False), (246, "A", False), (314, "S", False), (780, "U", False), (834, "?", False)]:
        d.ellipse((16, y - 23, 62, y + 23), fill="#f5efe6" if active else "#282a2c")
        draw_text(d, (31 if label != "+" else 29, y - 14), label, 22 if label == "+" else 17, "#111214" if active else "#d4ccc1", "bold")

    draw_text(d, (96, 40), "OmniClaw", 28, "#f3eee7", "bold")
    draw_text(d, (96, 78), "Agent workbench", 13, "#9b948c")
    rounded(d, (96, 112, 304, 162), 16, "#303134")
    draw_text(d, (124, 127), "New task", 16, "#f3eee7", "semibold")
    draw_text(d, (96, 210), "PROJECTS", 12, "#8f877e", "bold")
    rounded(d, (96, 234, 304, 276), 13, "#28292b")
    draw_text(d, (122, 247), "OmniClaw V2", 14, "#e5ded5", "semibold")
    draw_text(d, (96, 314), "ALL TASKS", 12, "#8f877e", "bold")
    tasks = [
        ("Frontend rebuild", "Design reference pack", True),
        ("Brain setup fix", "NVIDIA key + model fetch", False),
        ("Computer access", "Files, browser, terminal", False),
        ("Hermes parity map", "Tools and skills gap", False),
    ]
    for i, (title, sub, active) in enumerate(tasks):
        y = 336 + i * 68
        rounded(d, (96, y, 304, y + 54), 15, "#343537" if active else "#232426")
        dot(d, 118, y + 27, "#4da3ff" if active else "#6e655d")
        draw_text(d, (136, y + 11), title, 14, "#fbf7ef" if active else "#d6cec4", "semibold")
        draw_text(d, (136, y + 33), sub, 12, "#aaa196")
    rounded(d, (96, 774, 304, 844), 18, "#28292b")
    d.ellipse((114, 796, 146, 828), fill="#ec7a2f")
    draw_text(d, (160, 795), "Mankush", 15, "#fbf7ef", "bold")
    draw_text(d, (160, 818), "Owner mode on", 12, "#a79f96")

    draw_text(d, (374, 32), "OmniClaw 2.0 Power", 25, "#191715", "bold")
    draw_text(d, (374, 66), "One task workspace: transcript, plan, tools, memory, and computer.", 14, "#756d65")
    pill(d, (820, 30, 930, 68), "main", "#ffffff", "#312d29", 13, True)
    pill(d, (944, 30, 1012, 68), "gpt-5.5", "#ffffff", "#312d29", 13, True)

    shadowed(img, (374, 112, 998, 205), 26, "#ffffff", "#ded6ca", alpha=22)
    draw_text(d, (410, 142), "User", 15, "#1f1d1a", "bold")
    draw_text(d, (410, 170), "Pura frontend rebuild karo, pehle reference images polish karo.", 16, "#36312c")

    shadowed(img, (374, 232, 998, 416), 26, "#fffdf9", "#ded6ca", alpha=24)
    draw_text(d, (410, 264), "OmniClaw", 16, "#1f1d1a", "bold")
    draw_text(d, (410, 296), "Samjha. Main rough dashboard ko real agent app mein convert kar raha hoon:", 15, "#3c3834")
    for i, label in enumerate(["collapsible sidebar", "task transcript", "live computer", "BYOK wizard"]):
        pill(d, (410 + (i % 2) * 190, 332 + (i // 2) * 38, 570 + (i % 2) * 190, 360 + (i // 2) * 38), label, "#eef6ff" if i < 2 else "#f8eee5", "#2472ad" if i < 2 else "#9b4d1f", 12, True)

    for x, title, metric, sub in [(374, "Plan", "5", "screens"), (586, "Tools", "18", "visible actions"), (798, "Memory", "on", "task recall")]:
        shadowed(img, (x, 450, x + 200, 548), 22, "#ffffff", "#ded6ca", alpha=18)
        draw_text(d, (x + 26, 480), title, 14, "#7b736b")
        draw_text(d, (x + 26, 506), metric, 28, "#181614", "bold")
        draw_text(d, (x + 74, 516), sub, 12, "#7b736b")

    shadowed(img, (374, 738, 998, 836), 28, "#ffffff", "#ded6ca", alpha=24)
    draw_text(d, (410, 780), "Assign a task or ask anything", 20, "#9a9188")
    for x, label in [(426, "+"), (482, "files"), (560, "model")]:
        pill(d, (x, 798, x + (42 if label == "+" else 74), 830), label, "#f1ede6", "#514a43", 12, True)
    d.ellipse((930, 774, 978, 822), fill="#111214")
    draw_text(d, (946, 785), "go", 15, "#ffffff", "bold")

    draw_text(d, (1072, 34), "Omni's Computer", 24, "#191715", "bold")
    draw_text(d, (1072, 68), "Browser, terminal, files, tools, artifacts", 13, "#756d65")
    rounded(d, (1072, 108, 1392, 424), 28, "#242426")
    rounded(d, (1096, 136, 1368, 292), 16, "#f7f7f6")
    draw_text(d, (1118, 166), "https://docs / references", 14, "#706b66")
    rounded(d, (1118, 205, 1348, 252), 10, "#e8e4dd")
    rounded(d, (1096, 316, 1368, 392), 16, "#101111")
    draw_text(d, (1118, 344), "$ npm run build", 14, "#b9f7c5", "mono")
    draw_text(d, (1118, 366), "ready in 1.2s", 12, "#6f8f74", "mono")
    shadowed(img, (1072, 462, 1392, 650), 24, "#ffffff", "#ded6ca", alpha=18)
    draw_text(d, (1102, 500), "Task progress", 18, "#1d1b18", "bold")
    for y, c, label, sub in [(538, "#4da3ff", "Collect references", "done"), (584, "#4da3ff", "Polish mockups", "active"), (630, "#d7cec2", "Rebuild app shell", "next")]:
        dot(d, 1108, y, c)
        draw_text(d, (1130, y - 12), label, 14, "#39342f", "semibold")
        draw_text(d, (1282, y - 12), sub, 12, "#756d65")
    shadowed(img, (1072, 684, 1392, 806), 24, "#ffffff", "#ded6ca", alpha=18)
    draw_text(d, (1102, 724), "Permission state", 18, "#1d1b18", "bold")
    draw_text(d, (1102, 754), "Files: ask before delete", 13, "#756d65")
    draw_text(d, (1102, 778), "Terminal: governed allowlist", 13, "#756d65")
    img.convert("RGB").save(OUT / "01-desktop-workbench.png", optimize=True)


def brain_setup():
    img = vertical_gradient((1440, 900), "#f5f1e8", "#ebe5dc")
    d = ImageDraw.Draw(img)
    shadowed(img, (56, 42, 1384, 858), 34, "#ffffff", "#ded6ca", alpha=26)
    rounded(d, (56, 42, 348, 858), 34, "#171819")
    draw_text(d, (96, 92), "Settings", 30, "#f5efe6", "bold")
    draw_text(d, (96, 132), "OmniClaw configuration", 13, "#a59d94")
    items = ["Brain and BYOK", "Profile", "Computer access", "Permissions", "Agents and skills", "Tools and MCP", "Memory", "Connectors"]
    for i, item in enumerate(items):
        y = 182 + i * 55
        rounded(d, (90, y, 314, y + 44), 14, "#303134" if i == 0 else "#171819")
        draw_text(d, (116, y + 13), item, 15, "#f5efe6" if i == 0 else "#a59d94", "semibold" if i == 0 else "regular")
    draw_text(d, (394, 92), "Brain setup", 32, "#171513", "bold")
    draw_text(d, (394, 132), "Paste a key, auto-fill endpoints, fetch models, test, then save.", 15, "#746c63")
    rounded(d, (394, 180, 1300, 258), 24, "#f4f0e9", "#ded6ca")
    for x, n, label, active in [(434, "1", "Provider", True), (590, "2", "Key", True), (730, "3", "Models", False), (898, "4", "Health test", False), (1090, "5", "Save", False)]:
        d.ellipse((x - 16, 203, x + 16, 235), fill="#111214" if active else "#e5ded4")
        draw_text(d, (x - 5, 207), n, 13, "#ffffff" if active else "#6a625a", "bold")
        draw_text(d, (x + 28, 207), label, 14, "#171513" if active else "#6a625a", "bold" if active else "regular")

    providers = [("OpenRouter", "200+ models", False), ("OpenAI", "native + compatible", False), ("NVIDIA NIM", "glm + hosted models", True), ("MiniMax", "fallback ready", False)]
    for i, (name, sub, active) in enumerate(providers):
        x = 394 + i * 222
        shadowed(img, (x, 296, x + 198, 400), 22, "#111214" if active else "#fffdf9", "#ded6ca", alpha=18)
        draw_text(d, (x + 24, 326), name, 17, "#ffffff" if active else "#1f1c19", "bold")
        draw_text(d, (x + 24, 356), sub, 12, "#bcb4aa" if active else "#766e66")
        if active:
            pill(d, (x + 24, 370, x + 102, 394), "active", "#2e8cff", "#ffffff", 11, True)

    shadowed(img, (394, 442, 872, 730), 26, "#fffdf9", "#ded6ca", alpha=20)
    draw_text(d, (430, 482), "Connection details", 20, "#1f1c19", "bold")
    fields = [("Provider", "NVIDIA NIM"), ("Base URL", "https://integrate.api.nvidia.com/v1"), ("Chat endpoint", "/chat/completions"), ("API key", "stored locally - never shown again")]
    for i, (label, val) in enumerate(fields):
        y = 526 + i * 48
        draw_text(d, (430, y), label, 12, "#766e66")
        rounded(d, (548, y - 10, 822, y + 28), 12, "#ffffff", "#ded6ca")
        draw_text(d, (566, y), val, 13, "#2c2824", "mono" if "http" in val or "/" in val else "regular")

    shadowed(img, (908, 442, 1300, 730), 26, "#fffdf9", "#ded6ca", alpha=20)
    draw_text(d, (944, 482), "Models and failover", 20, "#1f1c19", "bold")
    pill(d, (944, 520, 1084, 562), "Fetch models", "#111214", "#ffffff", 14, True)
    model_rows = [("glm-5.1", "default", "#2e8cff"), ("minimax-m2.7", "fallback", "#ec7a2f"), ("mock/local", "offline backup", "#bfb5aa")]
    for i, (model, sub, c) in enumerate(model_rows):
        y = 590 + i * 44
        rounded(d, (944, y, 1264, y + 36), 12, "#ffffff", "#ded6ca")
        dot(d, 966, y + 18, c)
        draw_text(d, (986, y + 8), model, 13, "#1f1c19", "semibold")
        draw_text(d, (1174, y + 8), sub, 12, "#766e66")
    rounded(d, (394, 764, 1300, 820), 22, "#111214")
    draw_text(d, (430, 782), "Provider health test", 15, "#ffffff", "bold")
    draw_text(d, (610, 782), "Checks key, /models, chat reply, and tool-loop compatibility before saving.", 13, "#bcb4aa")
    pill(d, (1190, 776, 1268, 810), "Save", "#ffffff", "#111214", 13, True)
    img.convert("RGB").save(OUT / "02-brain-setup.png", optimize=True)


def settings_permissions():
    img = vertical_gradient((1440, 900), "#101112", "#171819")
    d = ImageDraw.Draw(img)
    shadowed(img, (72, 54, 1368, 846), 34, "#1d1e20", "#303134", alpha=50)
    rounded(d, (112, 94, 440, 806), 28, "#252628")
    draw_text(d, (150, 142), "Settings hub", 32, "#f5efe6", "bold")
    draw_text(d, (150, 180), "All controls, one system.", 14, "#a49c93")
    nav = ["Profile", "Brain and BYOK", "Computer access", "Permissions", "Agents and skills", "Memory", "Channels", "Data controls"]
    for i, item in enumerate(nav):
        y = 232 + i * 56
        rounded(d, (148, y, 404, y + 42), 13, "#f5efe6" if i == 2 else "#303134")
        draw_text(d, (174, y + 12), item, 15, "#121314" if i == 2 else "#d7d0c7", "semibold" if i == 2 else "regular")
    draw_text(d, (500, 126), "Computer access", 31, "#f5efe6", "bold")
    draw_text(d, (500, 164), "Clear permission states for files, browser, terminal, and dangerous actions.", 14, "#a49c93")
    cards = [
        ("File roots", "Search and edit approved folders.", "C:\\\\Users\\\\PATEL COMPUTERS", "#dff3e7"),
        ("Terminal policy", "Risk-based allow, ask, deny.", "Ask for risky commands", "#e9f1ff"),
        ("Browser control", "Click, type, screenshot, automate.", "Enabled for local Chrome", "#f8eadf"),
        ("Delete/write gates", "Danger actions need confirmation.", "Ask before delete", "#fff1dc"),
    ]
    for i, (title, body, state, fill) in enumerate(cards):
        x = 500 + (i % 2) * 414
        y = 220 + (i // 2) * 210
        shadowed(img, (x, y, x + 374, y + 170), 24, fill, "#423b35", alpha=28)
        draw_text(d, (x + 30, y + 32), title, 20, "#191715", "bold")
        draw_text(d, (x + 30, y + 66), body, 14, "#5d554e")
        pill(d, (x + 30, y + 112, x + 230, y + 148), state, "#ffffff", "#25211d", 12, True)
    shadowed(img, (500, 660, 1288, 782), 26, "#252628", "#343537", alpha=36)
    draw_text(d, (536, 700), "Approval timeline", 20, "#f5efe6", "bold")
    for i, (label, status, c) in enumerate([("delete dist/temp", "waiting", "#ec7a2f"), ("npm run build", "allowed", "#4da3ff"), ("open browser", "auto", "#63c174")]):
        x = 536 + i * 230
        dot(d, x, 746, c)
        draw_text(d, (x + 20, 732), label, 14, "#efe8df", "semibold")
        draw_text(d, (x + 20, 754), status, 12, "#aaa196")
    pill(d, (1136, 714, 1240, 754), "Review", "#f5efe6", "#111214", 13, True)
    img.convert("RGB").save(OUT / "03-settings-permissions.png", optimize=True)


def agent_studio():
    img = vertical_gradient((1440, 900), "#f4f0e8", "#e9e2d8")
    d = ImageDraw.Draw(img)
    rounded(d, (38, 38, 330, 862), 32, "#171819")
    draw_text(d, (80, 88), "Agents", 31, "#f5efe6", "bold")
    draw_text(d, (80, 128), "Identity, tools, skills, memory.", 13, "#a49c93")
    agents = [("Billu Baba", "main assistant", True), ("Researcher", "web + citations", False), ("Builder", "code + terminal", False), ("Operator", "scheduled tasks", False)]
    for i, (name, sub, active) in enumerate(agents):
        y = 178 + i * 78
        rounded(d, (80, y, 288, y + 58), 18, "#303134" if active else "#242527")
        d.ellipse((102, y + 18, 124, y + 40), fill="#ec7a2f" if active else "#6b645d")
        draw_text(d, (140, y + 11), name, 15, "#f5efe6", "bold" if active else "regular")
        draw_text(d, (140, y + 34), sub, 12, "#a49c93")
    pill(d, (80, 760, 238, 806), "Create agent", "#f5efe6", "#111214", 14, True)
    draw_text(d, (386, 82), "Agent studio", 34, "#191715", "bold")
    draw_text(d, (386, 122), "Give each agent a birth certificate: identity, skills, tools, memory, and test lane.", 15, "#746c63")
    shadowed(img, (386, 176, 880, 430), 28, "#ffffff", "#ded6ca", alpha=20)
    draw_text(d, (424, 218), "Identity", 22, "#191715", "bold")
    fields = [("Name", "Billu Baba"), ("Purpose", "Hinglish build partner for Mankush"), ("Tone", "Direct, practical, no fake claims")]
    for i, (label, val) in enumerate(fields):
        y = 262 + i * 50
        draw_text(d, (424, y), label, 12, "#746c63")
        rounded(d, (520, y - 10, 820, y + 30), 12, "#f8f5ef", "#ded6ca")
        draw_text(d, (540, y), val, 13, "#312d29")
    shadowed(img, (914, 176, 1310, 430), 28, "#ffffff", "#ded6ca", alpha=20)
    draw_text(d, (952, 218), "Tool access", 22, "#191715", "bold")
    for i, (label, on) in enumerate([("Browser", True), ("Terminal", True), ("Files", True), ("Web", True), ("MCP", False), ("Voice", False), ("Cron", False), ("Delete", False)]):
        x = 952 + (i % 2) * 150
        y = 262 + (i // 2) * 44
        pill(d, (x, y, x + 128, y + 34), label, "#111214" if on else "#eee7dd", "#ffffff" if on else "#514941", 12, True)
    shadowed(img, (386, 470, 1310, 638), 28, "#ffffff", "#ded6ca", alpha=18)
    draw_text(d, (424, 510), "Skills and memory", 22, "#191715", "bold")
    for i, (title, sub, c) in enumerate([("browser-research", "enabled", "#4da3ff"), ("frontend-builder", "recommended", "#ec7a2f"), ("memory-recall", "always on", "#63c174"), ("skill-create", "review first", "#b98cff")]):
        x = 424 + i * 210
        rounded(d, (x, 542, x + 180, 596), 16, "#f8f5ef", "#ded6ca")
        dot(d, x + 22, 568, c)
        draw_text(d, (x + 40, 552), title, 13, "#191715", "bold")
        draw_text(d, (x + 40, 574), sub, 12, "#746c63")
    shadowed(img, (386, 682, 1310, 804), 28, "#171819", "#303134", alpha=34)
    draw_text(d, (424, 722), "Test lane", 22, "#f5efe6", "bold")
    draw_text(d, (424, 760), "Try a prompt and inspect provider, tools, permissions, memory, and result before live use.", 14, "#aaa196")
    pill(d, (1110, 726, 1232, 770), "Test agent", "#f5efe6", "#111214", 14, True)
    img.convert("RGB").save(OUT / "04-agent-studio.png", optimize=True)


def mobile_shell():
    img = vertical_gradient((900, 1400), "#101112", "#191a1b")
    d = ImageDraw.Draw(img)
    shadowed(img, (44, 44, 856, 1356), 56, "#202122", "#333436", alpha=50)
    rounded(d, (86, 86, 814, 206), 30, "#28292b")
    draw_text(d, (124, 122), "OmniClaw 2.0", 40, "#f5efe6", "bold")
    draw_text(d, (124, 168), "Power profile", 20, "#a49c93")
    d.ellipse((718, 113, 782, 177), fill="#ec7a2f")
    draw_text(d, (741, 129), "M", 28, "#ffffff", "bold")
    draw_text(d, (124, 286), "What can I do", 64, "#f5efe6", "serif")
    draw_text(d, (124, 362), "for you?", 64, "#f5efe6", "serif")
    shadowed(img, (124, 436, 776, 640), 36, "#2a2b2d", "#3b3c3e", alpha=24)
    draw_text(d, (166, 504), "Assign a task or ask anything", 27, "#a49c93")
    for x, label in [(178, "+"), (268, "files"), (382, "model"), (520, "voice")]:
        pill(d, (x - 30, 552, x + 60, 610), label, "#343537", "#eee7dd", 18 if label == "+" else 16, True)
    d.ellipse((686, 546, 756, 616), fill="#f5efe6")
    draw_text(d, (712, 566), "go", 20, "#111214", "bold")
    shadowed(img, (124, 692, 776, 884), 34, "#f5efe6", "#ded6ca", alpha=22)
    draw_text(d, (164, 740), "Task progress", 26, "#191715", "bold")
    for y, label, c in [(786, "Research UI references", "#4da3ff"), (836, "Polish mockups", "#ec7a2f")]:
        dot(d, 172, y, c)
        draw_text(d, (200, y - 14), label, 22, "#37322d", "semibold")
    shadowed(img, (124, 930, 776, 1160), 34, "#f5efe6", "#ded6ca", alpha=22)
    draw_text(d, (164, 978), "Omni Computer", 26, "#191715", "bold")
    draw_text(d, (164, 1016), "Browser, terminal, files, artifacts", 19, "#746c63")
    rounded(d, (164, 1050, 722, 1122), 20, "#ffffff", "#ded6ca")
    draw_text(d, (194, 1072), "Using browser - reference-board.html", 20, "#5a524a")
    for x, label, active in [(124, "Tasks", False), (304, "Agents", False), (484, "Library", False), (664, "More", True)]:
        rounded(d, (x, 1208, x + 144, 1268), 30, "#f5efe6" if active else "#2b2c2e")
        draw_text(d, (x + 36, 1225), label, 21, "#111214" if active else "#d8d0c7", "semibold")
    img.convert("RGB").save(OUT / "05-mobile-shell.png", optimize=True)


if __name__ == "__main__":
    desktop_workbench()
    brain_setup()
    settings_permissions()
    agent_studio()
    mobile_shell()
    print(f"Polished wireframes written to {OUT}")
