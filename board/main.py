from machine import Pin, PWM, ADC  # type: ignore
import network  # type: ignore
import time
import machine  # type: ignore
from umqtt.simple import MQTTClient  # type: ignore
import os

machine.freq(80000000)

# Conditional REPL / UART disable for power saving.
# Set to a GPIO number (active-low) to enable REPL when held; keep None to disable REPL by default.
DEBUG_ENABLE_PIN = 8

def _is_debug_pressed():
    if DEBUG_ENABLE_PIN is None:
        return False
    try:
        p = Pin(DEBUG_ENABLE_PIN, Pin.IN, Pin.PULL_UP)
        return p.value() == 0
    except Exception:
        return False

def _maybe_disable_repl():
    # If debug pin is pressed, leave REPL enabled. Otherwise attempt to disable dupterm and deinit UART0.
    if _is_debug_pressed():
        return
    try:
        import uos # type: ignore
        try:
            uos.dupterm(None)
        except Exception:
            pass
    except Exception:
        pass
    try:
        # Some ports expose UART via machine.UART
        uart0 = machine.UART(0)
        try:
            uart0.deinit()
        except Exception:
            pass
    except Exception:
        pass

try:
    import ujson as json  # type: ignore
except ImportError:
    import json

try:
    import urequests as requests  # type: ignore
except ImportError:
    requests = None

try:
    import uhashlib as hashlib  # type: ignore
except ImportError:
    hashlib = None

try:
    import ubinascii  # type: ignore
except ImportError:
    ubinascii = None

# ---- WiFi / MQTT ----
WIFI_PROFILE = {
    "ssid": "quiznet",
    "password": "esp32-c3",
}

# Only attempt to connect to the primary quiz Wi‑Fi network.
WIFI_PROFILES = [WIFI_PROFILE]
MQTT_PORT = 1883
GAMEPAD_ID_PREFIX = "g"

WIFI_CONNECT_TIMEOUT_S = 5
BUTTON_DEBOUNCE_MS = 200
RSSI_SEND_EVERY_MS = 5000
MQTT_KEEPALIVE_S = 10
OTA_TEMP_FILE = "main.new.py"
OTA_TARGET_FILE = "main.py"
OTA_BACKUP_FILE = "main.bak.py"

# ---- Power safety net ----
# If startup follows an unstable reset (brownout-like behavior), sleep to protect battery.
BROWNOUT_SAFETY_ENABLED = True
BROWNOUT_SAFETY_SLEEP_MS = 3_600_000  # 1 hour


CLK = 9
DIO = 1
RED_PIN = 2
GREEN_PIN = 3
BLUE_PIN = 4
BUTTON_PINS = [10, 7, 6, 5, 8]  # A, B, C, D, R
BUTTON_LABELS = ["A", "B", "C", "D", "R"]

RGB_ACTIVE_LOW = False

LED_BRIGHTNESS = 0.05
DISPLAY_BRIGHTNESS_LEVEL = 1  # TM1637 brightness range: 0..7

# ---- TM1637 ----
ADDR_AUTO = 0x40
ADDR_FIXED = 0x44
START_ADDR = 0xC0
DISP_ON = 0x88

PATTERN_A = 0x77
PATTERN_B = 0x7C
PATTERN_C = 0x39
PATTERN_D = 0x5E
PATTERN_E = 0x79
PATTERN_F = 0x71
PATTERN_DASH = 0x40

DIGITS = {
    "0": 0x3F,
    "1": 0x06,
    "2": 0x5B,
    "3": 0x4F,
    "4": 0x66,
    "5": 0x6D,
    "6": 0x7D,
    "7": 0x07,
    "8": 0x7F,
    "9": 0x6F,
}

LETTER_PATTERN = {
    "A": PATTERN_A,
    "B": PATTERN_B,
    "C": PATTERN_C,
    "D": PATTERN_D,
    "E": PATTERN_E,
    "F": PATTERN_F,
}


clk = Pin(CLK, Pin.OUT, value=1)
dio = Pin(DIO, Pin.OUT, value=1)
buttons = [Pin(gpio, Pin.IN, Pin.PULL_UP) for gpio in BUTTON_PINS]

red_pwm = PWM(Pin(RED_PIN, Pin.OUT), freq=1000, duty_u16=0)
green_pwm = PWM(Pin(GREEN_PIN, Pin.OUT), freq=1000, duty_u16=0)
blue_pwm = PWM(Pin(BLUE_PIN, Pin.OUT), freq=1000, duty_u16=0)

# Battery ADC (voltage divider on BAT_ADC_PIN -> ADC -> GND)
BAT_ADC_PIN = 0
# Battery mapping parameters (adjust if you want different min/max)
BATTERY_VOLTAGE_MIN = 3.0
BATTERY_VOLTAGE_MAX = 4.2
_ADC_REF_VOLTS = 3.3

try:
    battery_adc = ADC(Pin(BAT_ADC_PIN))
    battery_adc.atten(ADC.ATTN_11DB)
except Exception:
    battery_adc = None

# Sampling and mapping tweaks
BATTERY_SAMPLES = 10
BATTERY_SAMPLE_DELAY_MS = 3
# Exponential moving average alpha for displayed percentage (0..1)
BATTERY_EMA_ALPHA = 0.35
# Shutdown if battery below this (V)
BATTERY_SHUTDOWN_VOLTAGE = 3.00

# Voltage -> SOC mapping (approximate for 18650). Adjust if you have measured data.
# Format: (voltage, percent)
BATTERY_SOC_TABLE = [
    (3.00, 0),
    (3.20, 5),
    (3.40, 10),
    (3.50, 20),
    (3.60, 35),
    (3.70, 50),
    (3.80, 65),
    (3.90, 78),
    (4.00, 88),
    (4.10, 96),
    (4.20, 100),
]

# EMA state (internal)
_battery_pct_ema = None


def _delay_us(us=5):
    time.sleep_us(us)


def _set_dio_output(value):
    dio.init(Pin.OUT)
    dio.value(value)


def tm_start():
    _set_dio_output(1)
    clk.value(1)
    _delay_us()
    dio.value(0)


def tm_stop():
    clk.value(0)
    _delay_us()
    _set_dio_output(0)
    _delay_us()
    clk.value(1)
    _delay_us()
    dio.value(1)


def tm_write_byte(data):
    for _ in range(8):
        clk.value(0)
        dio.value(1 if (data & 0x01) else 0)
        data >>= 1
        _delay_us()
        clk.value(1)
        _delay_us()

    clk.value(0)
    dio.init(Pin.IN, Pin.PULL_UP)
    _delay_us()
    clk.value(1)
    _delay_us()
    _set_dio_output(0)
    clk.value(0)


def tm_init():
    tm_start()
    tm_write_byte(ADDR_AUTO)
    tm_stop()
    tm_start()
    tm_write_byte(DISP_ON | (DISPLAY_BRIGHTNESS_LEVEL & 0x07))
    tm_stop()
    display_clear()


def tm_write_at(pos, data):
    tm_start()
    tm_write_byte(ADDR_FIXED)
    tm_stop()
    tm_start()
    tm_write_byte(START_ADDR | (pos & 0x03))
    tm_write_byte(data)
    tm_stop()


def tm_write_all(pattern):
    tm_start()
    tm_write_byte(ADDR_AUTO)
    tm_stop()
    tm_start()
    tm_write_byte(START_ADDR)
    for _ in range(4):
        tm_write_byte(pattern)
    tm_stop()


def display_clear():
    tm_write_all(0x00)

def gamepad_id_suffix(gamepad_id):
    if not gamepad_id:
        return "----"
    token = str(gamepad_id)
    if "-" in token:
        token = token.split("-")[-1]
    token = token.upper()
    token = token[-4:]
    while len(token) < 4:
        token = "-" + token
    return token


def display_identify_id(gamepad_id):
    token = gamepad_id_suffix(gamepad_id)
    out = [0x00, 0x00, 0x00, 0x00]
    for idx, ch in enumerate(token[:4]):
        if ch in DIGITS:
            out[idx] = DIGITS[ch]
        elif ch in LETTER_PATTERN:
            out[idx] = LETTER_PATTERN[ch]
        elif ch == "-":
            out[idx] = PATTERN_DASH
        else:
            out[idx] = 0x00

    for pos in range(4):
        tm_write_at(pos, out[pos])


def display_letters_fixed(letters):
    display_clear()
    for ch in letters:
        if ch not in LETTER_PATTERN:
            continue
        pos = "ABCD".find(ch)
        if pos >= 0:
            tm_write_at(pos, LETTER_PATTERN[ch])


def display_letters_ordered(letters):
    display_clear()
    for idx, ch in enumerate(letters[:4]):
        if ch in LETTER_PATTERN:
            tm_write_at(idx, LETTER_PATTERN[ch])


def display_number(num):
    s = str(int(num))
    if len(s) > 4:
        s = s[-4:]

    out = [0x00, 0x00, 0x00, 0x00]
    idx = 3
    for ch in reversed(s):
        if idx < 0:
            break
        if ch == "-":
            out[idx] = PATTERN_DASH
        else:
            out[idx] = DIGITS.get(ch, 0x00)
        idx -= 1

    for pos in range(4):
        tm_write_at(pos, out[pos])


def _to_u16(v8):
    return int((max(0, min(255, v8)) * 65535) / 255)


def set_led_rgb(r, g, b):
    r = int(max(0, min(255, r)) * LED_BRIGHTNESS)
    g = int(max(0, min(255, g)) * LED_BRIGHTNESS)
    b = int(max(0, min(255, b)) * LED_BRIGHTNESS)

    if RGB_ACTIVE_LOW:
        r = 255 - r
        g = 255 - g
        b = 255 - b

    red_pwm.duty_u16(_to_u16(r))
    green_pwm.duty_u16(_to_u16(g))
    blue_pwm.duty_u16(_to_u16(b))


def _read_adc_raw(adc):
    try:
        return adc.read_u16()
    except Exception:
        try:
            v = adc.read()
            if v is None:
                return None
            return int(round((v / 4095.0) * 65535.0))
        except Exception:
            return None


def get_battery_voltage():
    """Read ADC multiple times (trimmed/averaged) and return battery voltage (V).

    Returns None if ADC not available or reads fail.
    """
    if battery_adc is None:
        return None

    samples = []
    for _ in range(BATTERY_SAMPLES):
        raw = _read_adc_raw(battery_adc)
        if raw is not None:
            samples.append(raw)
        time.sleep_ms(BATTERY_SAMPLE_DELAY_MS)

    if not samples:
        return None

    # Optionally discard min/max to reduce spike influence when sample count is small
    if len(samples) > 2:
        samples.sort()
        samples = samples[1:-1]

    avg_raw = float(sum(samples)) / float(len(samples))
    voltage_at_pin = (avg_raw / 65535.0) * _ADC_REF_VOLTS
    # Account for 1:1 divider (two equal resistors)
    return voltage_at_pin * 2.0


def _voltage_to_soc_lookup(v):
    # Linear interpolate over BATTERY_SOC_TABLE
    if v is None:
        return None
    table = BATTERY_SOC_TABLE
    if v <= table[0][0]:
        return table[0][1]
    if v >= table[-1][0]:
        return table[-1][1]
    # find interval
    for i in range(1, len(table)):
        v0, p0 = table[i - 1]
        v1, p1 = table[i]
        if v0 <= v <= v1:
            if v1 == v0:
                return p1
            t = (v - v0) / (v1 - v0)
            return int(round(p0 + t * (p1 - p0)))
    return None


def get_battery_percentage():
    """Return smoothed battery percentage (0..100) using lookup mapping and EMA."""
    global _battery_pct_ema

    v = get_battery_voltage()
    if v is None:
        return None

    raw_pct = _voltage_to_soc_lookup(v)
    if raw_pct is None:
        # fallback to linear
        raw_pct = int(round((v - BATTERY_VOLTAGE_MIN) / (BATTERY_VOLTAGE_MAX - BATTERY_VOLTAGE_MIN) * 100.0))

    if raw_pct < 0:
        raw_pct = 0
    elif raw_pct > 100:
        raw_pct = 100

    if _battery_pct_ema is None:
        _battery_pct_ema = float(raw_pct)
    else:
        _battery_pct_ema = (_battery_pct_ema * (1.0 - BATTERY_EMA_ALPHA)) + (raw_pct * BATTERY_EMA_ALPHA)

    return int(round(_battery_pct_ema))


def maybe_enter_brownout_safety_sleep():
    if not BROWNOUT_SAFETY_ENABLED:
        return

    cause = machine.reset_cause()

    # If battery is critically low, avoid running and protect the cell by sleeping.
    try:
        bv = get_battery_voltage()
        if isinstance(bv, (int, float)) and bv > 0 and bv < BATTERY_SHUTDOWN_VOLTAGE:
            # Sleep long to avoid deep discharge; will wake on reset/charger
            time.sleep_ms(50)
            machine.deepsleep(BROWNOUT_SAFETY_SLEEP_MS)
    except Exception:
        pass

    unstable_causes = set()
    for name in ["WDT_RESET", "BROWN_OUT_RESET", "BROWNOUT_RESET"]:
        value = getattr(machine, name, None)
        if isinstance(value, int):
            unstable_causes.add(value)

    if cause in unstable_causes:
        time.sleep_ms(50)
        machine.deepsleep(BROWNOUT_SAFETY_SLEEP_MS)


def _wifi_attempt_failed(status_code):
    failure_codes = {
        getattr(network, "STAT_WRONG_PASSWORD", None),
        getattr(network, "STAT_NO_AP_FOUND", None),
        getattr(network, "STAT_CONNECT_FAIL", None),
    }
    return status_code in failure_codes


def connect_wifi(sta_if, on_wait=None):
    sta_if.active(True)
    sta_if.config(pm=0)
    # If already connected to the desired SSID, return immediately.
    if sta_if.isconnected():
        current_ssid = None
        try:
            current_ssid = sta_if.config("ssid")
        except Exception:
            current_ssid = None

        if current_ssid == WIFI_PROFILE.get("ssid"):
            return WIFI_PROFILE

        # If connected to something else, disconnect and continue to connect
        try:
            sta_if.disconnect()
        except Exception:
            pass

    # Only attempt to connect to the single primary profile (quiznet).
    profile = WIFI_PROFILE
    ssid = profile.get("ssid")
    password = profile.get("password")

    sta_if.connect(ssid, password)
    start = time.time()
    while not sta_if.isconnected():
        if on_wait is not None:
            on_wait()
        if _wifi_attempt_failed(sta_if.status()):
            break
        if time.time() - start > WIFI_CONNECT_TIMEOUT_S:
            break
        time.sleep(0.2)

    if sta_if.isconnected():
        return profile

    raise OSError("WiFi connect failed for primary profile")


def build_gamepad_id(sta_if):
    sta_if.active(True)
    mac = sta_if.config("mac")
    if not mac:
        return "{}-unknown".format(GAMEPAD_ID_PREFIX)
    return "{}-{}".format(GAMEPAD_ID_PREFIX, "".join("{:02x}".format(b) for b in mac))


# ---- Runtime state ----
current_phase = "idle"
current_question_id = None
current_answer_type = "single"
selected = []
identify_display_enabled = False
identify_number = None

# Local monotonic timing (ms) recorded with time.ticks_ms()
start_ms = None
choice_ms = None
end_ms = None

_mqtt_client_ref = {"client": None, "submit_topic": "", "gamepad_id": ""}


def display_identify_number():
    if identify_number is None:
        display_clear()
        return
    display_number(identify_number)


def clear_selection():
    global selected
    selected = []


def has_vote():
    return len(selected) > 0


def render_selection_display():
    if current_answer_type == "ordering":
        display_letters_ordered(selected)
    else:
        display_letters_fixed(selected)


def publish_submit(mqtt_client, submit_topic, gamepad_id):
    global start_ms, choice_ms, end_ms
    try:
        end_ms = time.ticks_ms()
    except Exception:
        try:
            end_ms = int(time.time() * 1000)
        except Exception:
            end_ms = None

    payload = {
        "selection": selected,
        "timing": {
            "startMs": start_ms if (start_ms is not None) else None,
            "choiceMs": choice_ms if (choice_ms is not None) else None,
            "endMs": end_ms if (end_ms is not None) else None,
        },
    }
    try:
        mqtt_client.publish(submit_topic.encode(), json.dumps(payload).encode(), qos=1)
    except Exception:
        # best-effort: ignore publish failures
        pass


def publish_telemetry_status(status_type, status, detail=""):
    c = _mqtt_client_ref.get("client")
    gamepad_id = _mqtt_client_ref.get("gamepad_id", "")
    if c is None or not gamepad_id:
        return

    topic = "gamepad/{}/telemetry".format(gamepad_id)
    payload = {
        "type": status_type,
        "status": status,
        "detail": str(detail or "")[:120],
    }
    try:
        c.publish(topic.encode(), json.dumps(payload).encode(), qos=0)
    except Exception:
        pass


def _sha256_hex(data):
    if hashlib is None or ubinascii is None:
        return None
    if isinstance(data, str):
        data = data.encode()
    h = hashlib.sha256()
    h.update(data)
    return ubinascii.hexlify(h.digest()).decode().lower()


def perform_ota_update(url, expected_sha256=None):
    if requests is None:
        raise OSError("urequests missing")
    response = None
    temp_f = None
    try:
        response = requests.get(url)
        status = getattr(response, "status_code", 200)
        if status != 200:
            raise OSError("HTTP {}".format(status))

        # Stream the response to avoid allocating the whole payload in RAM.
        hasher = None
        if expected_sha256 and hashlib is not None and ubinascii is not None:
            try:
                hasher = hashlib.sha256()
            except Exception:
                hasher = None

        temp_f = open(OTA_TEMP_FILE, "wb")
        try:
            raw = getattr(response, "raw", None)
            if raw and hasattr(raw, "read"):
                # Read in small chunks
                while True:
                    chunk = raw.read(1024)
                    if not chunk:
                        break
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8")
                    temp_f.write(chunk)
                    if hasher is not None:
                        try:
                            hasher.update(chunk)
                        except Exception:
                            pass
            else:
                body = getattr(response, "content", None)
                if body is None:
                    # Fallback for some urequests variants
                    readfn = getattr(response, "read", None)
                    if callable(readfn):
                        body = readfn()
                if isinstance(body, str):
                    body = body.encode("utf-8")
                if not body:
                    raise OSError("empty payload")
                temp_f.write(body)
                if hasher is not None:
                    try:
                        hasher.update(body)
                    except Exception:
                        pass
            try:
                temp_f.flush()
            except Exception:
                pass
        finally:
            try:
                temp_f.close()
            except Exception:
                pass

        if expected_sha256 and hasher is not None:
            try:
                got = ubinascii.hexlify(hasher.digest()).decode().lower()
            except Exception:
                got = None
            want = str(expected_sha256).strip().lower()
            if got and got != want:
                try:
                    os.remove(OTA_TEMP_FILE)
                except Exception:
                    pass
                raise OSError("sha mismatch")

    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass

    # Try to rotate files: remove old backup, move current target to backup,
    # fall back to removing current target if rename fails, then move temp -> target.
    try:
        os.remove(OTA_BACKUP_FILE)
    except Exception:
        pass

    try:
        os.rename(OTA_TARGET_FILE, OTA_BACKUP_FILE)
    except Exception:
        try:
            os.remove(OTA_TARGET_FILE)
        except Exception:
            pass

    # Final install step
    os.rename(OTA_TEMP_FILE, OTA_TARGET_FILE)
    # Post-install verification removed (streaming hash already validated earlier).


def apply_button_input(button_label):
    global selected, start_ms, choice_ms, end_ms

    if current_phase != "voting":
        return

    if button_label == "R":
        if has_vote():
            clear_selection()
            display_clear()
        return

    if button_label not in ["A", "B", "C", "D"]:
        return

    # capture previous selection to detect real changes
    try:
        prev_sel = list(selected)
    except Exception:
        prev_sel = []

    if current_answer_type == "single":
        if has_vote():
            return
        selected = [button_label]
    elif current_answer_type == "multiple":
        # For multiple-answer questions, pressing a choice selects it and it remains
        # selected until cleared with the R button. Do not toggle on repeated presses.
        if button_label in selected:
            # already selected; no change
            pass
        else:
            selected = selected + [button_label]
            selected.sort()
    else:  # ordering
        if button_label in selected:
            return
        if len(selected) >= 4:
            return
        selected = selected + [button_label]

    # record choice time only when selection actually changed and selection is non-empty
    try:
        prev_str = "|".join(prev_sel)
        new_str = "|".join(selected or [])
        if prev_str != new_str and len(selected) > 0:
            try:
                choice_ms = time.ticks_ms()
            except Exception:
                try:
                    choice_ms = int(time.time() * 1000)
                except Exception:
                    choice_ms = None
    except Exception:
        pass

    if has_vote():
        render_selection_display()
    else:
        display_clear()
def handle_control_message(data):
    global current_phase, current_question_id, current_answer_type, identify_display_enabled, identify_number, start_ms, choice_ms, end_ms

    msg_type = str(data.get("type", "")).lower()

    if msg_type == "fw-update":
        url = str(data.get("url", "")).strip()
        if not url:
            return

        expected_sha256 = data.get("sha256")
        publish_telemetry_status("fw-update-status", "start", "downloading")
        try:
            perform_ota_update(url, expected_sha256=expected_sha256)
            publish_telemetry_status("fw-update-status", "ok", "rebooting")
            time.sleep_ms(120)
            machine.reset()
        except Exception as err:
            publish_telemetry_status("fw-update-status", "error", str(err))
        return

    if msg_type == "submit-request":
        try:
            c = _mqtt_client_ref["client"]
            if c is not None:
                publish_submit(c, _mqtt_client_ref["submit_topic"], _mqtt_client_ref["gamepad_id"])
            set_led_rgb(0, 0, 0)
        except Exception:
            pass
        return

    # Final statistics: turn LED off but preserve whatever is currently
    # shown on the display (e.g. total points). This is triggered by the
    # admin finalization action so devices keep showing totals but LEDs
    # are switched off.
    if msg_type == "final-stats" or msg_type == "finalstats":
        try:
            set_led_rgb(0, 0, 0)
        except Exception:
            pass
        return

    if msg_type == "identify-display":
        identify_display_enabled = bool(data.get("enabled", False))
        raw_number = data.get("identifyNumber")
        try:
            n = int(raw_number)
            identify_number = n if n > 0 else None
        except Exception:
            identify_number = None
        if current_phase != "voting":
            if identify_display_enabled:
                display_identify_number()
            elif current_phase == "collecting":
                render_selection_display() if has_vote() else display_clear()
            else:
                display_clear()
        return

    if msg_type == "phase":
        phase = str(data.get("phase", "")).lower()
        current_phase = phase
        if "identifyDisplayEnabled" in data:
            identify_display_enabled = bool(data.get("identifyDisplayEnabled"))
        if "identifyNumber" in data:
            raw_number = data.get("identifyNumber")
            try:
                n = int(raw_number)
                identify_number = n if n > 0 else None
            except Exception:
                identify_number = None

        q = data.get("question") if isinstance(data.get("question"), dict) else {}
        current_question_id = q.get("id")
        current_answer_type = str(q.get("answerType", "single")).lower()
        if current_answer_type not in ["single", "multiple", "ordering"]:
            current_answer_type = "single"

        if phase == "voting":
            clear_selection()
            display_clear()
            # start local monotonic timer for this voting round
            try:
                start_ms = time.ticks_ms()
            except Exception:
                try:
                    start_ms = int(time.time() * 1000)
                except Exception:
                    start_ms = None
            choice_ms = None
            end_ms = None
            set_led_rgb(0, 0, 255)
        elif phase == "collecting":
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()
            else:
                render_selection_display() if has_vote() else display_clear()
        elif phase in ["question", "welcome", "idle"]:
            clear_selection()
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()
            else:
                display_clear()
        elif phase in ["review", "reveal"]:
            if identify_display_enabled:
                display_identify_number()
        elif phase == "finished":
            # Final screen: turn LED off, keep currently shown value (e.g., points) on display.
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()


def handle_result_message(data):
    msg_type = str(data.get("type", "")).lower()
    if msg_type != "result":
        return

    correct = bool(data.get("correct", False))
    if correct:
        set_led_rgb(0, 255, 0)  # green
    else:
        # incorrect or timeout -> red
        set_led_rgb(255, 0, 0)

    total_points = int(data.get("totalPoints", 0))
    if identify_display_enabled and current_phase != "voting":
        display_identify_number()
    else:
        display_number(total_points)


def on_mqtt_message(topic, msg):
    topic_str = topic.decode() if isinstance(topic, bytes) else str(topic)
    msg_str = msg.decode() if isinstance(msg, bytes) else str(msg)

    try:
        data = json.loads(msg_str)
    except Exception:
        return

    if topic_str.endswith("/control"):
        handle_control_message(data)
    elif topic_str.endswith("/result"):
        handle_result_message(data)


def connect_mqtt(gamepad_id, broker_host):
    client = MQTTClient(
        gamepad_id.encode(), broker_host, port=MQTT_PORT, keepalive=MQTT_KEEPALIVE_S
    )
    client.set_callback(on_mqtt_message)
    client.connect()
    client.subscribe(("gamepad/{}/control".format(gamepad_id)).encode(), qos=1)
    client.subscribe(("gamepad/{}/result".format(gamepad_id)).encode(), qos=1)

    _mqtt_client_ref["client"] = client
    _mqtt_client_ref["submit_topic"] = "gamepad/{}/submit".format(gamepad_id)
    _mqtt_client_ref["gamepad_id"] = gamepad_id
    return client


def read_rssi_dbm(sta_if):
    try:
        return int(sta_if.status("rssi"))
    except Exception:
        return None


def show_disconnected_led():
    # Stable red while MQTT broker connection is not established.
    set_led_rgb(255, 0, 0)


def show_disconnected_feedback():
    show_disconnected_led()
    # While disconnected, show battery percentage on the display.
    try:
        p = get_battery_percentage()
    except Exception:
        p = None

    if p is None:
        display_clear()
    else:
        display_number(p)


def main():
    # Disable REPL / UART early unless debug button is held at boot.
    _maybe_disable_repl()
    maybe_enter_brownout_safety_sleep()

    tm_init()
    display_clear()
    set_led_rgb(0, 0, 0)

    sta_if = network.WLAN(network.STA_IF)
    gamepad_id = build_gamepad_id(sta_if)
    display_clear()

    mqtt_client = None
    active_mqtt_broker = None
    telemetry_topic = "gamepad/{}/telemetry".format(gamepad_id)

    prev_values = [1 for _ in BUTTON_LABELS]
    last_sent_ms_by_button = {label: 0 for label in BUTTON_LABELS}
    last_rssi_send_ms = time.ticks_ms() - RSSI_SEND_EVERY_MS
    disconnect_backoff_until_ms = 0
    # Fixed short backoff (ms) between reconnect attempts — keep trying quickly.
    reconnect_backoff_ms = 100

    while True:
        now_ms = time.ticks_ms()

        if mqtt_client is None:
            show_disconnected_feedback()
            if time.ticks_diff(now_ms, disconnect_backoff_until_ms) < 0:
                time.sleep_ms(20)
                continue

        try:
            connect_wifi(sta_if, on_wait=show_disconnected_feedback)
            # Derive broker from the connected interface's subnet (.1).
            target_mqtt_broker = None
            try:
                ip = None
                try:
                    ip = sta_if.ifconfig()[0]
                except Exception:
                    ip = None
                if ip:
                    parts = ip.split(".")
                    if len(parts) == 4:
                        parts[3] = "1"
                        target_mqtt_broker = ".".join(parts)
            except Exception:
                target_mqtt_broker = None

            # If we couldn't derive a broker, skip MQTT connect attempt and backoff.
            if not target_mqtt_broker:
                if mqtt_client is not None:
                    try:
                        mqtt_client.disconnect()
                    except Exception:
                        pass
                    mqtt_client = None
                    active_mqtt_broker = None
                    _mqtt_client_ref["client"] = None
                # Use the configured short fixed backoff when broker is unknown.
                disconnect_backoff_until_ms = time.ticks_add(time.ticks_ms(), reconnect_backoff_ms)
                time.sleep_ms(20)
                continue
            now_ms = time.ticks_ms()

            if mqtt_client is None or active_mqtt_broker != target_mqtt_broker:
                if mqtt_client is not None:
                    try:
                        mqtt_client.disconnect()
                    except Exception:
                        pass
                mqtt_client = connect_mqtt(gamepad_id, target_mqtt_broker)
                active_mqtt_broker = target_mqtt_broker
                # Reset backoff after a successful connection
                reconnect_backoff_ms = 200
                if current_phase != "voting":
                    set_led_rgb(0, 0, 0)

            mqtt_client.check_msg()

            if time.ticks_diff(now_ms, last_rssi_send_ms) >= RSSI_SEND_EVERY_MS:
                last_rssi_send_ms = now_ms
                rssi = read_rssi_dbm(sta_if)
                if rssi is not None:
                    payload = {"rssiDbm": rssi}
                    try:
                        bp = get_battery_percentage()
                        if bp is not None:
                            payload["batteryPct"] = int(bp)
                    except Exception:
                        pass
                    mqtt_client.publish(telemetry_topic.encode(), json.dumps(payload).encode(), qos=0)

            # Button edge detection
            for idx, label in enumerate(BUTTON_LABELS):
                v = buttons[idx].value()
                was = prev_values[idx]
                prev_values[idx] = v

                if not (was == 1 and v == 0):
                    continue

                last_sent = last_sent_ms_by_button[label]
                if time.ticks_diff(now_ms, last_sent) < BUTTON_DEBOUNCE_MS:
                    continue

                last_sent_ms_by_button[label] = now_ms

                # R only clears vote while in voting; A-D follow current answer mode.
                apply_button_input(label)

            time.sleep_ms(20)

            # If collector requested submit, it arrives on /control as submit-request.
            # We check it by reading messages above; on command side we publish immediately.
            # (Implementation: handle submit-request in control handler by publishing submit.)

        except Exception:
            if mqtt_client is not None:
                try:
                    mqtt_client.disconnect()
                except Exception:
                    pass
                mqtt_client = None
                active_mqtt_broker = None
                _mqtt_client_ref["client"] = None
            # Apply fixed short reconnect backoff so we keep trying quickly.
            disconnect_backoff_until_ms = time.ticks_add(time.ticks_ms(), reconnect_backoff_ms)
            time.sleep_ms(20)


main()
