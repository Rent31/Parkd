use crate::common;

#[tokio::test]
async fn console_assets_are_public_but_admin_data_is_not() {
	let ctx = common::context();
	let base = ctx.garage.admin_uri();
	for (path, content_type) in [
		("/console/", "text/html"),
		("/console/app.css", "text/css"),
		("/console/app.js", "text/javascript"),
		("/console/delegated.html", "text/html"),
		("/console/delegated.js", "text/javascript"),
	] {
		let response = ctx.admin_client.get(format!("{base}{path}")).send().await.unwrap();
		assert!(response.status().is_success());
		assert!(response.headers()["content-type"].to_str().unwrap().starts_with(content_type));
		assert_eq!(response.headers()["x-content-type-options"], "nosniff");
		assert!(response.headers().contains_key("content-security-policy"));
	}
	let response = ctx.admin_client.get(format!("{base}/v2/GetClusterHealth")).send().await.unwrap();
	assert!(response.status().is_client_error());
	let response = ctx.admin_client.post(format!("{base}/console/")).send().await.unwrap();
	assert!(!response.status().is_success());
}
