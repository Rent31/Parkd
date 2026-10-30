use aws_sdk_s3::primitives::ByteStream;
use serde_json::json;

use crate::common;

#[tokio::test]
async fn quota_limits_accept_large_unsigned_values() {
	let ctx = common::context();
	let bucket = ctx.create_bucket("quota-unsigned");
	let info = ctx
		.admin_get(&format!("GetBucketInfo?globalAlias={bucket}"))
		.send()
		.await
		.unwrap();
	assert!(info.status().is_success());
	let info: serde_json::Value = info.json().await.unwrap();
	let id = info["id"].as_str().unwrap();

	let set_quota = |size, objects| {
		ctx.admin_post(&format!("UpdateBucket?id={id}"))
			.json(&json!({ "quotas": { "maxSize": size, "maxObjects": objects } }))
	};
	let response = set_quota(3_u64, 1_u64).send().await.unwrap();
	assert!(response.status().is_success());
	assert!(ctx
		.client
		.put_object()
		.bucket(&bucket)
		.key("test")
		.body(ByteStream::from_static(b"data"))
		.send()
		.await
		.is_err());

	let response = set_quota(u64::MAX, u64::MAX).send().await.unwrap();
	assert!(response.status().is_success());
	ctx.client
		.put_object()
		.bucket(&bucket)
		.key("test")
		.body(ByteStream::from_static(b"data"))
		.send()
		.await
		.unwrap();
}
