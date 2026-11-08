"""Drive the REAL LibreChat client (headless chromium) through: new-chat upload,
send message, existing-chat upload. Credentials are throwaway, generated here,
never printed or written. Usage: drive.py <scratch-dir>"""
import secrets, sys, time, pathlib
from playwright.sync_api import sync_playwright

BASE = "http://localhost:13081"
scratch = pathlib.Path(sys.argv[1]); scratch.mkdir(parents=True, exist_ok=True)
pw = "Aa1!" + secrets.token_hex(8)
email = f"probe-{secrets.token_hex(3)}@example.invalid"
f1 = scratch / "probe-new-chat.txt"; f1.write_text("probe file for new chat\n")
f2 = scratch / "probe-existing-chat.txt"; f2.write_text("probe file for existing chat\n")

def shot(page, name):
    page.screenshot(path=str(scratch / f"{name}.png"))

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 900})
    page.goto(f"{BASE}/register"); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
    page.fill('input[name="name"]', "probe"); page.fill('input[name="username"]', "probe" + secrets.token_hex(2))
    page.fill('input[name="email"]', email); page.fill('input[name="password"]', pw)
    page.fill('input[name="confirm_password"]', pw)
    page.click('button[type="submit"]'); page.wait_for_timeout(6000)
    if "/login" in page.url:
        page.fill('input[name="email"]', email); page.fill('input[name="password"]', pw)
        page.click('button[type="submit"]'); page.wait_for_timeout(5000)
    shot(page, "1-after-login"); print("url after login:", page.url.split("?")[0])
    page.goto(f"{BASE}/c/new"); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500); page.wait_for_timeout(2000)
    print("new-chat url:", page.url)
    # NEW CHAT upload: attach through the composer's hidden file input
    inp = page.locator('input[type="file"]').first
    inp.set_input_files(str(f1)); page.wait_for_timeout(4000); shot(page, "2-new-chat-attached")
    page.fill('textarea', "probe message"); page.keyboard.press("Enter")
    page.wait_for_timeout(8000); shot(page, "3-after-send"); print("url after send:", page.url)
    # EXISTING CHAT upload
    inp = page.locator('input[type="file"]').first
    inp.set_input_files(str(f2)); page.wait_for_timeout(4000); shot(page, "4-existing-chat-attached")
    page.fill('textarea', "probe message two"); page.keyboard.press("Enter")
    page.wait_for_timeout(6000); shot(page, "5-after-send-2"); print("final url:", page.url)
    b.close()
