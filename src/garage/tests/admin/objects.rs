use aws_sdk_s3::primitives::ByteStream;
use serde_json::json;

use crate::common;

#[tokio::test]
async fn object_browser_pages_and_rejects_invalid_requests() {
	let ctx = common::context();
	let bucket = ctx.create_bucket("object-browser");
	for key in ["p/", "p/a", "p/b", "p/c", "q/other"] {
		ctx.client.put_object().bucket(&bucket).key(key)
			.body(ByteStream::from_static(b"data")).send().await.unwrap();
	}
	let info = ctx.admin_get(&format!("GetBucketInfo?globalAlias={bucket}"))
		.send().await.unwrap().json::<serde_json::Value>().await.unwrap();
	let id = info["id"].as_str().unwrap();
	let page = |after: Option<&str>| ctx.admin_post("ListBucketObjects")
		.json(&json!({"bucketId": id, "prefix": "p/", "limit": 2, "after": after}));
	let first = page(None).send().await.unwrap();
	assert!(first.status().is_success());
	let first: serde_json::Value = first.json().await.unwrap();
	assert_eq!(first["objects"][0]["key"], "p/");
	assert_eq!(first["objects"][0]["size"], 4);
	assert!(first["objects"][0]["etag"].as_str().is_some());
	assert!(first["objects"][0]["modifiedMsec"].as_u64().is_some());
	assert_eq!(first["objects"][1]["key"], "p/a");
	assert_eq!(first["nextAfter"], "p/a");

	let normal = page(first["nextAfter"].as_str()).send().await.unwrap();
	assert!(normal.status().is_success());
	let normal: serde_json::Value = normal.json().await.unwrap();
	assert_eq!(normal["objects"][0]["key"], "p/b");
	assert_eq!(normal["objects"][1]["key"], "p/c");
	assert!(normal["nextAfter"].is_null());

	// Deleting the continuation key must not cause the next key to be skipped.
	ctx.client.delete_object().bucket(&bucket).key("p/a").send().await.unwrap();
	let second = page(first["nextAfter"].as_str()).send().await.unwrap();
	assert!(second.status().is_success());
	let second: serde_json::Value = second.json().await.unwrap();
	assert_eq!(second["objects"].as_array().unwrap().len(), 2);
	assert_eq!(second["objects"][0]["key"], "p/b");
	assert_eq!(second["objects"][1]["key"], "p/c");
	assert!(second["nextAfter"].is_null());

	for body in [
		json!({"bucketId": id, "limit": 0}),
		json!({"bucketId": id, "limit": 1001}),
		json!({"bucketId": id, "prefix": "p/", "after": "q/other"}),
	] {
		let res = ctx.admin_post("ListBucketObjects").json(&body).send().await.unwrap();
		assert!(res.status().is_client_error());
	}
	let unauthorized = ctx.admin_client.post(format!("{}/v2/ListBucketObjects", ctx.garage.admin_uri()))
		.json(&json!({"bucketId": id})).send().await.unwrap();
	assert!(unauthorized.status().is_client_error());
}

#[tokio::test]
async fn bucket_scoped_token_cannot_read_other_buckets_or_admin_apis() {
	let ctx = common::context();
	let first = ctx.create_bucket("scoped-a");
	let second = ctx.create_bucket("scoped-b");
	for bucket in [&first, &second] {
		ctx.client.put_object().bucket(bucket).key("secret")
			.body(ByteStream::from_static(b"data")).send().await.unwrap();
	}
	let mut ids = Vec::new();
	for bucket in [&first, &second] {
		let info = ctx.admin_get(&format!("GetBucketInfo?globalAlias={bucket}"))
			.send().await.unwrap().json::<serde_json::Value>().await.unwrap();
		ids.push(info["id"].as_str().unwrap().to_owned());
	}
	let created = ctx.admin_post("CreateAdminToken")
		.json(&json!({"name": "bucket-only", "scope": [format!("ListBucketObjects:{}", ids[0])]}))
		.send().await.unwrap();
	assert!(created.status().is_success());
	let created: serde_json::Value = created.json().await.unwrap();
	let token = created["secretToken"].as_str().unwrap();
	let token_id = created["id"].as_str().unwrap();
	let identity = ctx.admin_client.get(format!("{}/v2/GetCurrentAdminTokenInfo", ctx.garage.admin_uri()))
		.bearer_auth(token).send().await.unwrap();
	assert!(identity.status().is_success());
	let identity: serde_json::Value = identity.json().await.unwrap();
	assert_eq!(identity["id"], token_id);
	assert_eq!(identity["scope"], json!([format!("ListBucketObjects:{}", ids[0])]));
	let url = format!("{}/v2/ListBucketObjects", ctx.garage.admin_uri());
	let browse = |bucket_id: &str| ctx.admin_client.post(&url).bearer_auth(token)
		.json(&json!({"bucketId": bucket_id}));
	let permitted = browse(&ids[0]).send().await.unwrap();
	assert!(permitted.status().is_success());
	let permitted: serde_json::Value = permitted.json().await.unwrap();
	assert_eq!(permitted["objects"][0]["key"], "secret");
	let denied = browse(&ids[1]).send().await.unwrap();
	assert_eq!(denied.status().as_u16(), 403);
	for endpoint in ["ListBuckets", "ListBucketsInfo", "GetClusterStatus", "ListKeys"] {
		let response = ctx.admin_client.get(format!("{}/v2/{endpoint}", ctx.garage.admin_uri()))
			.bearer_auth(token).send().await.unwrap();
		assert_eq!(response.status().as_u16(), 403, "{endpoint} unexpectedly succeeded");
	}
	assert_eq!(browse(&format!("{}0", ids[0])).send().await.unwrap().status().as_u16(), 403);
	let response = ctx.admin_client.get(format!("{}/v2/GetBucketInfo?id={}", ctx.garage.admin_uri(), ids[0]))
		.bearer_auth(token).send().await.unwrap();
	assert_eq!(response.status().as_u16(), 403);
	let response = ctx.admin_client.get(format!("{}/v2/InspectObject?bucketId={}&key=secret", ctx.garage.admin_uri(), ids[0]))
		.bearer_auth(token).send().await.unwrap();
	assert_eq!(response.status().as_u16(), 403);
	let response = ctx.admin_client.post(format!("{}/v2/CreateAdminToken", ctx.garage.admin_uri()))
		.bearer_auth(token).json(&json!({"scope":["*"]})).send().await.unwrap();
	assert_eq!(response.status().as_u16(), 403);
	let deleted = ctx.admin_post(&format!("DeleteAdminToken?id={token_id}"))
		.send().await.unwrap();
	assert!(deleted.status().is_success());
	assert_eq!(browse(&ids[0]).send().await.unwrap().status().as_u16(), 403);
}
