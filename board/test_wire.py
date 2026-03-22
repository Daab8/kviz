from machine import Pin, PWM  # type: ignore
import time

# --- Pin Definitions ---
CLK = 0
DIO = 1
RED_PIN = 2
GREEN_PIN = 3
BLUE_PIN = 4

BUTTON_PINS = [10, 7, 6, 5, 8]  # A, B, C, D, R

# Set True if RGB LED is common-anode (inverted PWM).
RGB_ACTIVE_LOW = False
# 0.0..1.0 brightness scaling for RGB output.
LED_BRIGHTNESS = 0.01

# --- TM1637 Commands ---
ADDR_AUTO = 0x40
ADDR_FIXED = 0x44
START_ADDR = 0xC0
DISP_ON = 0x88

# --- Segment Patterns (0b0GFEDCBA) ---
PATTERNS = [
	0x77,  # A (Position 0)
	0x7C,  # b (Position 1)
	0x39,  # C (Position 2)
	0x5E,  # d (Position 3)
	0x40,  # - (Dash)
]


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

	# Wait for ACK
	clk.value(0)
	dio.init(Pin.IN, Pin.PULL_UP)
	_delay_us()
	clk.value(1)
	_delay_us()
	ack = dio.value() == 0
	_set_dio_output(0)
	clk.value(0)
	return ack


def tm_init():
	tm_start()
	tm_write_byte(ADDR_AUTO)
	tm_stop()
	tm_start()
	tm_write_byte(DISP_ON + 7)  # Max brightness
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


def _to_u16(v8):
	# Map 0..255 to 0..65535
	return int((max(0, min(255, v8)) * 65535) / 255)


def set_led(r, g, b):
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


def main():
	tm_init()
	set_led(0, 0, 0)

	while True:
		# Button 1: 'A' at pos 0
		if buttons[0].value() == 0:
			display_clear()
			tm_write_at(0, PATTERNS[0])
			set_led(255, 0, 0)  # Red
		# Button 2: 'B' at pos 1
		elif buttons[1].value() == 0:
			display_clear()
			tm_write_at(1, PATTERNS[1])
			set_led(0, 255, 0)  # Green
		# Button 3: 'C' at pos 2
		elif buttons[2].value() == 0:
			display_clear()
			tm_write_at(2, PATTERNS[2])
			set_led(0, 0, 255)  # Blue
		# Button 4: 'D' at pos 3
		elif buttons[3].value() == 0:
			display_clear()
			tm_write_at(3, PATTERNS[3])
			set_led(255, 100, 0)  # Orange
		# Button 5: "----"
		elif buttons[4].value() == 0:
			tm_write_all(PATTERNS[4])
			set_led(0, 0, 0)  # Off

		time.sleep_ms(100)


main()
