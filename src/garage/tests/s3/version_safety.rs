use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};

use crate::common;

#[tokio::test]
async fn version_requests_do_not_read_or_delete_current_objects() {
	let ctx = common::context();
	let bucket = ctx.create_bucket("version-safety");
	for key in ["first", "second"] {
		let result = ctx.client.put_object().bucket(&bucket).key(key)
			.body(ByteStream::from_static(b"current"))
			.send().await.unwrap();
		assert!(result.version_id.is_none());
	}
	assert!(ctx.client.get_object().bucket(&bucket).key("first")
		.version_id("old-version").send().await.is_err());
	assert!(ctx.client.head_object().bucket(&bucket).key("first")
		.version_id("old-version").send().await.is_err());
	assert!(ctx.client.delete_object().bucket(&bucket).key("first")
		.version_id("old-version").send().await.is_err());
	let empty_version = ctx.custom_request.builder(bucket.clone())
		.method(hyper::Method::DELETE)
		.path("first")
		.query_param("versionId", Some(""))
		.send().await.unwrap();
	assert!(empty_version.status().is_client_error());

	let batch = Delete::builder()
		.objects(ObjectIdentifier::builder().key("second").build().unwrap())
		.objects(ObjectIdentifier::builder().key("first").version_id("old-version").build().unwrap())
		.build().unwrap();
	assert!(ctx.client.delete_objects().bucket(&bucket).delete(batch).send().await.is_err());
	for key in ["first", "second"] {
		let result = ctx.client.get_object().bucket(&bucket).key(key).send().await.unwrap();
		assert_bytes_eq!(result.body, b"current");
	}
	assert!(ctx.client.copy_object().bucket(&bucket).key("copy")
		.copy_source(format!("{bucket}/first?versionId=old-version"))
		.send().await.is_err());
	assert!(ctx.client.head_object().bucket(&bucket).key("copy").send().await.is_err());
}
