-- The market data feed serves no ten-minute grain. It accepts 1, 5, 15, and 60
-- minute bars plus daily, and everything coarser is folded from those, so
-- `MIN_10` is no longer a candle interval the domain recognizes.
--
-- Rows still holding it cannot be decoded and are skipped on read, which leaves
-- them as permanent dead weight: invisible to the application but still carried
-- by every table scan. Every such row is already terminal — a rule that has
-- finished or a monitor that has fired — so there is nothing live to preserve.
DELETE FROM `stop_rules` WHERE `interval` = 'MIN_10';--> statement-breakpoint
DELETE FROM `price_alerts` WHERE `interval` = 'MIN_10';--> statement-breakpoint
DELETE FROM `market_monitors` WHERE `interval` = 'MIN_10';
