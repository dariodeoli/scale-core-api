-- Stable mention targets for comments. The text remains readable when a
-- profile is renamed; notification delivery uses these membership IDs.
create table if not exists agency_project_comment_mentions (
 organization_id bigint not null references organizations(id) on delete cascade,
 project_comment_id bigint not null references agency_project_comments(id) on delete cascade,
 mentioned_user_id bigint not null references users(id) on delete cascade,
 primary key(organization_id,project_comment_id,mentioned_user_id)
);
create index if not exists project_comment_mentions_recipient_idx
 on agency_project_comment_mentions(organization_id,mentioned_user_id,project_comment_id desc);

create table if not exists agency_order_comment_mentions (
 organization_id bigint not null references organizations(id) on delete cascade,
 order_comment_id bigint not null references agency_order_comments(id) on delete cascade,
 mentioned_user_id bigint not null references users(id) on delete cascade,
 primary key(organization_id,order_comment_id,mentioned_user_id)
);
create index if not exists order_comment_mentions_recipient_idx
 on agency_order_comment_mentions(organization_id,mentioned_user_id,order_comment_id desc);
