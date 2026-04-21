UPDATE provider_settings
SET live_speech_threshold = 0.0024
WHERE ABS(live_speech_threshold - 0.0012) < 0.0000001;
