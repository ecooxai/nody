UPDATE provider_settings
SET live_speech_threshold = 0.007
WHERE ABS(live_speech_threshold - 0.0024) < 0.0000001;
