from machine import Pin, PWM  # type: ignore
import network  # type: ignore
import time
import machine  # type: ignore
from umqtt.simple import MQTTClient  # type: ignore
import os

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

# ---- Wiring (matches test_wiring.py) ----
CLK = 0
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


def display_dashes():
    display_clear()


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


def maybe_enter_brownout_safety_sleep():
    if not BROWNOUT_SAFETY_ENABLED:
        return

    cause = machine.reset_cause()

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

flash_blue = False
flash_led_on = False

_mqtt_client_ref = {"client": None, "submit_topic": "", "gamepad_id": ""}


def display_identify_number():
    if identify_number is None:
        display_dashes()
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
    payload = {
        "selection": selected,
    }
    mqtt_client.publish(submit_topic.encode(), json.dumps(payload).encode(), qos=1)


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
    try:
        response = requests.get(url)
        status = getattr(response, "status_code", 200)
        if status != 200:
            raise OSError("HTTP {}".format(status))

        body = response.content
        if not body:
            raise OSError("empty payload")

        if expected_sha256:
            got = _sha256_hex(body)
            want = str(expected_sha256).strip().lower()
            if got and got != want:
                raise OSError("sha mismatch")

        with open(OTA_TEMP_FILE, "wb") as f:
            f.write(body)

    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass

    try:
        os.remove(OTA_BACKUP_FILE)
    except Exception:
        pass

    try:
        os.rename(OTA_TARGET_FILE, OTA_BACKUP_FILE)
    except Exception:
        pass

    os.rename(OTA_TEMP_FILE, OTA_TARGET_FILE)


def apply_button_input(button_label):
    global selected

    if current_phase != "voting":
        return

    if button_label == "R":
        if has_vote():
            clear_selection()
            display_dashes()
        return

    if button_label not in ["A", "B", "C", "D"]:
        return

    if current_answer_type == "single":
        if has_vote():
            return
        selected = [button_label]
    elif current_answer_type == "multiple":
        if button_label in selected:
            selected = [x for x in selected if x != button_label]
        else:
            selected = selected + [button_label]
            selected.sort()
    else:  # ordering
        if button_label in selected:
            return
        if len(selected) >= 4:
            return
        selected = selected + [button_label]

    if has_vote():
        render_selection_display()
    else:
        display_dashes()


def handle_control_message(data):
    global current_phase, current_question_id, current_answer_type, identify_display_enabled, identify_number
    global flash_blue, flash_led_on

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
                render_selection_display() if has_vote() else display_dashes()
            else:
                display_dashes()
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
            flash_blue = True
            flash_led_on = True
            display_dashes()
            set_led_rgb(0, 0, 255)
        elif phase == "collecting":
            flash_blue = False
            flash_led_on = False
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()
            else:
                render_selection_display() if has_vote() else display_dashes()
        elif phase in ["question", "welcome", "idle"]:
            clear_selection()
            flash_blue = False
            flash_led_on = False
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()
            else:
                display_dashes()
        elif phase in ["review", "reveal"]:
            # Keep last result feedback (LED + points) visible until a new question/welcome arrives.
            flash_blue = False
            flash_led_on = False
            if identify_display_enabled:
                display_identify_number()
        elif phase == "finished":
            flash_blue = False
            flash_led_on = False
            # Final screen: turn LED off, keep currently shown value (e.g., points) on display.
            set_led_rgb(0, 0, 0)
            if identify_display_enabled:
                display_identify_number()


def handle_result_message(data):
    global flash_blue, flash_led_on

    msg_type = str(data.get("type", "")).lower()
    if msg_type != "result":
        return

    flash_blue = False
    flash_led_on = False

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


def update_voting_led():
    global flash_led_on

    if current_phase != "voting":
        return

    # For single-choice questions, first valid vote means input is effectively final.
    # For multiple/ordering, keep blue LED on so player knows they can still modify/extend selection.
    if has_vote() and current_answer_type == "single":
        flash_led_on = False
        set_led_rgb(0, 0, 0)
        return

    if not flash_led_on:
        flash_led_on = True
        set_led_rgb(0, 0, 255)


def show_disconnected_led():
    # Stable purple while MQTT broker connection is not established.
    set_led_rgb(160, 0, 255)


def show_disconnected_feedback():
    display_dashes()
    show_disconnected_led()


def main():
    maybe_enter_brownout_safety_sleep()

    tm_init()
    display_dashes()
    set_led_rgb(0, 0, 0)

    sta_if = network.WLAN(network.STA_IF)
    gamepad_id = build_gamepad_id(sta_if)
    display_dashes()

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
            wifi_profile = connect_wifi(sta_if, on_wait=show_disconnected_feedback)
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

            update_voting_led()
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
