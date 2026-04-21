ALTER TABLE provider_settings ADD COLUMN live_echo_cancellation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider_settings ADD COLUMN live_noise_suppression INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_settings ADD COLUMN live_auto_gain_control INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_settings ADD COLUMN live_silence_trim INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider_settings ADD COLUMN live_speech_threshold REAL NOT NULL DEFAULT 0.0012;
ALTER TABLE provider_settings ADD COLUMN live_trim_sensitivity REAL NOT NULL DEFAULT 0.18;
