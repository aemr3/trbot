-- The market data feed serves an order book for a stock and for the contract
-- written on it. The brokerage feed carried only the underlying's book, so the
-- depth panel had nothing to choose between; now it does, and which one the
-- trader last looked at is worth restoring alongside the chart's own target.
ALTER TABLE `app_preferences` ADD `depth_target` text DEFAULT 'UNDERLYING' NOT NULL;
