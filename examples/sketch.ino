// An Arduino sketch, built with the wasm-rtos Arduino core: the LED blinks,
// the button counts presses through an interrupt, and the LM75 on Wire
// reports the temperature.
//
// Build: <wasm-rtos>/arduino/build.sh examples/sketch.ino -o examples/sketch.wasm
#include <Wire.h>

const uint8_t BUTTON = 0;  // "gpio0" of the device profile
const uint8_t LM75 = 0x48;

volatile unsigned presses = 0;
void pressed() { presses++; }

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON), pressed, FALLING);
  Wire.begin();
  Serial.println(F("Sketch running: press the button, move the LM75 slider"));
}

float readCelsius() {
  Wire.beginTransmission(LM75);
  Wire.write(0x00);  // the temperature register
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(LM75, (uint8_t)2) != 2)
    return NAN;
  int16_t raw = (int16_t)((Wire.read() << 8) | Wire.read());
  return raw / 256.0f;
}

void loop() {
  static bool on = false;
  on = !on;
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
  if (on) {
    Serial.print(F("temperature "));
    Serial.print(readCelsius(), 1);
    Serial.print(F(" C, presses "));
    Serial.println(presses);
  }
  delay(500);
}
