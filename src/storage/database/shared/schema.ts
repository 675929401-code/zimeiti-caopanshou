import { pgTable, serial, varchar, timestamp, boolean, integer, text, index, uuid } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"


export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 用户表 - 学员账号
export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		username: varchar("username", { length: 64 }).notNull().unique(),
		password_hash: varchar("password_hash", { length: 255 }).notNull(),
		display_name: varchar("display_name", { length: 128 }).notNull(),
		role: varchar("role", { length: 20 }).notNull().default("student"), // admin | student
		credits: integer("credits").notNull().default(0),
		is_active: boolean("is_active").default(true).notNull(),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index("users_username_idx").on(table.username),
		index("users_role_idx").on(table.role),
	]
);

// 智能体表 - 管理员添加的智能体
export const agents = pgTable(
	"agents",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 128 }).notNull(),
		description: text("description"),
		avatar: varchar("avatar", { length: 512 }),
		category: varchar("category", { length: 64 }).notNull().default("通用"),
		source: varchar("source", { length: 20 }).notNull().default("llm"), // llm | coze
		bot_id: varchar("bot_id", { length: 128 }), // Coze bot_id 或 LLM model
		model: varchar("model", { length: 64 }).default("deepseek-v4-flash"),
		system_prompt: text("system_prompt"),
		cost_per_message: integer("cost_per_message").notNull().default(10),
		sort_order: integer("sort_order").default(0),
		is_active: boolean("is_active").default(true).notNull(),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index("agents_category_idx").on(table.category),
		index("agents_source_idx").on(table.source),
		index("agents_sort_idx").on(table.sort_order),
	]
);

// 积分流水表
export const creditTransactions = pgTable(
	"credit_transactions",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		type: varchar("type", { length: 20 }).notNull(), // recharge | consume
		amount: integer("amount").notNull(),
		description: varchar("description", { length: 255 }),
		balance_after: integer("balance_after").notNull(),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("credit_transactions_user_id_idx").on(table.user_id),
		index("credit_transactions_type_idx").on(table.type),
		index("credit_transactions_created_at_idx").on(table.created_at),
	]
);

// 平台设置表 - 管理员可配置
export const platformSettings = pgTable(
	"platform_settings",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		setting_key: varchar("setting_key", { length: 128 }).notNull().unique(),
		setting_value: text("setting_value").notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index("platform_settings_key_idx").on(table.setting_key),
	]
);

// 公告表
export const announcements = pgTable(
	"announcements",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		title: varchar("title", { length: 255 }).notNull(),
		content: text("content").notNull(),
		is_pinned: boolean("is_pinned").default(false).notNull(),
		is_active: boolean("is_active").default(true).notNull(),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index("announcements_active_idx").on(table.is_active),
		index("announcements_pinned_idx").on(table.is_pinned),
	]
);
