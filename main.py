import os
import threading
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
import telebot
from PIL import Image, ImageDraw, ImageFont

# ১. স্টাইলিশ ফন্ট অটো-ডাউনলোডার
FONT_PATH = "bold_font.ttf"
if not os.path.exists(FONT_PATH):
    try:
        font_url = "https://github.com/google/fonts/raw/main/ofl/ubuntu/Ubuntu-Bold.ttf"
        urllib.request.urlretrieve(font_url, FONT_PATH)
    except Exception:
        FONT_PATH = None

# ২. ডামী ওয়েব সার্ভার (render এর জন্য)
class DummyServer(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(b"MAMA! @Edustech Bot Is Strictly Alive!")

def keep_alive():
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(('0.0.0.0', port), DummyServer)
    server.serve_forever()

threading.Thread(target=keep_alive, daemon=True).start()

# ৩. বট কনফিগারেশন (রেন্ডার এনভায়রনমেন্ট থেকে টোকেন নেবে, ব্যাকআপ হিসেবে তোর টোকেন থাকবে)
BOT_TOKEN = os.environ.get("BOT_TOKEN", "8327503356:AAGrtjR3s6sK3LjUzTDhdzBc1YRrmRydxH4")
TARGET_CHANNEL = "@edustech" 

bot = telebot.TeleBot(BOT_TOKEN)

# ৪. ফাইল ও এপিকে হ্যান্ডলার
@bot.message_handler(content_types=['document'])
def handle_apks_and_files(message):
    try:
        file_name = message.document.file_name
        file_size_bytes = message.document.file_size
        file_size_mb = round(file_size_bytes / (1024 * 1024), 2)
        file_id = message.document.file_id
        
        fn_lower = file_name.lower()
        hashtags = ""
        if "vpn" in fn_lower: hashtags += "#vpn #premium"
        elif "game" in fn_lower or "mod" in fn_lower: hashtags += "#games #modapk"
        elif "browser" in fn_lower: hashtags += "#browser #secure"
        elif "edit" in fn_lower or "video" in fn_lower or "photo" in fn_lower: hashtags += "#editorapk #pro"
        else: hashtags += "#apps #free #tools"

        caption_text = (
            f"🔥 **New Upload Alert!** 🔥\n\n"
            f"📦 **Name:** {file_name}\n"
            f"💾 **Size:** {file_size_mb} MB\n"
            f"✅ **Status:** Tested & Clean\n\n"
            f"📢 **Join Our Channel:** {TARGET_CHANNEL}\n\n"
            f"{hashtags}"
        )
        bot.send_document(chat_id=TARGET_CHANNEL, document=file_id, caption=caption_text, parse_mode='Markdown')
        bot.reply_to(message, "🚀 সফলভাবে চ্যানেলে পোস্ট করা হয়েছে!")
    except Exception as e:
        bot.reply_to(message, f"❌ এরর: {str(e)}")

# ৫. ফটো হ্যান্ডলার (রাউন্ড শেপ নিয়ন ট্যাগ)
@bot.message_handler(content_types=['photo'])
def handle_photos(message):
    try:
        file_id = message.photo[-1].file_id
        file_info = bot.get_file(file_id)
        downloaded_file = bot.download_file(file_info.file_path)
        
        temp_img_path = "temp_incoming.jpg"
        with open(temp_img_path, 'wb') as new_file:
            new_file.write(downloaded_file)
            
        img = Image.open(temp_img_path)
        draw = ImageDraw.Draw(img)
        width, height = img.size
        
        box_width = int(width * 0.29)   
        box_height = int(height * 0.22) 
        margin = int(min(width, height) * 0.02)
        
        x1, y1 = margin, height - box_height - margin
        x2, y2 = margin + box_width, height - margin
        corner_radius = int(box_height * 0.25)
        
        draw.rounded_rectangle([x1, y1, x2, y2], radius=corner_radius, fill=(24, 28, 36))
        draw.rounded_rectangle([x1, y1, x2, y2], radius=corner_radius, outline=(0, 229, 255), width=4)
        
        logo_size = int(box_height * 0.35)
        logo_x = x1 + int(box_width * 0.08)
        logo_y = y1 + int((box_height - logo_size) / 2)
        
        draw.ellipse([logo_x, logo_y, logo_x + logo_size, logo_y + logo_size], fill=(255, 235, 59))
        draw.ellipse([logo_x + 4, logo_y + 4, logo_x + logo_size - 4, logo_y + logo_size - 4], fill=(24, 28, 36))
        draw.ellipse([logo_x + int(logo_size/3), logo_y + int(logo_size/3), logo_x + int(logo_size*2/3), logo_y + int(logo_size*2/3)], fill=(0, 229, 255))
        
        text_to_print = "@Edustech"
        font_size = int(box_height * 0.24)
        
        font = None
        if FONT_PATH and os.path.exists(FONT_PATH):
            try: font = ImageFont.truetype(FONT_PATH, font_size)
            except Exception: font = None

        if font is None:
            try: font = ImageFont.load_default(size=font_size)
            except TypeError: font = ImageFont.load_default()
        
        text_x = logo_x + logo_size + int(box_width * 0.06)
        text_y = y1 + int((box_height - font_size) / 2)

        draw.text((text_x, text_y), text_to_print, fill=(255, 235, 59), font=font)
        
        output_img_path = "clean_branded_image.jpg"
        img.save(output_img_path)
        
        with open(output_img_path, 'rb') as photo_to_send:
            bot.send_photo(chat_id=TARGET_CHANNEL, photo=photo_to_send, caption=f"🖼️ Branded Image Shared to {TARGET_CHANNEL}")
            
        bot.reply_to(message, "🔥 রাউন্ড শেপ নিয়ন ট্যাগসহ ছবি পোস্টেড!")
        os.remove(temp_img_path)
        os.remove(output_img_path)
    except Exception as e:
        bot.reply_to(message, f"❌ এরর: {str(e)}")

bot.infinity_polling()
